import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { idSchema,type Identity } from '@heart/contracts';
import { AppError,conflict,notFound,unavailable } from '../errors.js';
import { requireIdentity,type Context } from '../modules/context.js';
import { ownedSession,patientSessionView,turnsFor,createFollowupService } from '../followups/service.js';
import { GREETING } from '../agents/protocol.js';
import { connectAsr,type AsrConnection } from './asr.js';
import { synthesize } from './tts.js';
import { issueTicket,consumeTicket } from './tickets.js';

export async function registerVoice(context:Context) {
  const {app,db,config,providers}=context;const service=createFollowupService(context);
  const resources=new Map<string,{bytes:Buffer;expires:number;accountId:string;sessionId:string;version:number}>();
  const active=new Map<string,WebSocket>();
  const asrAvailable=()=>Boolean(providers.asr||(config.aliyunAsrAppKey&&config.aliyunAccessKeyId&&config.aliyunAccessKeySecret));
  const ttsAvailable=()=>Boolean(providers.tts||(config.dashscopeApiKey&&config.dashscopeUrl));
  const cleanup=setInterval(()=>{for(const [id,a]of resources)if(a.expires<Date.now())resources.delete(id);void db.query('DELETE FROM voice_tickets WHERE expires_at<now()').catch(()=>{});},60000);cleanup.unref();
  app.addHook('onClose',async()=>{clearInterval(cleanup);for(const socket of active.values())socket.close();resources.clear();});

  async function audioFor(identity:Identity,sessionId:string,expectedVersion:number,summary=false) {
    const session=await ownedSession(db,identity,sessionId);if(session.version!==expectedVersion)throw conflict();
    if(!ttsAvailable())throw unavailable('云端语音合成尚未配置，请暂时查看文字');
    const turns=await turnsFor(db,sessionId);const completed=turns.filter(t=>t.status==='completed');
    const text=summary&&session.summary ? '本次采集的信息如下。'+session.summary.items.map((v:any)=>`${v.label}：${v.value}。`).join('') : completed.at(-1)?.assistant_text||GREETING;
    const bytes:Buffer=providers.tts?await providers.tts.synthesize(text):await synthesize(config,text);
    if(!bytes.length||bytes.length>4_000_000)throw unavailable('语音文件未完整生成，请重试');
    const current=await ownedSession(db,identity,sessionId);if(current.version!==expectedVersion)throw conflict('信息已经更正，旧语音已失效');
    while(resources.size>=40||[...resources.values()].reduce((sum,r)=>sum+r.bytes.length,0)+bytes.length>30_000_000){const oldest=resources.keys().next().value;if(!oldest)break;resources.delete(oldest);}
    const resourceId=randomUUID();resources.set(resourceId,{bytes,expires:Date.now()+180000,accountId:identity.accountId,sessionId,version:expectedVersion});
    return {resourceId,downloadPath:`/api/v1/voice/audio/${resourceId}`,ticket:await issueTicket(db,identity,current,'audio',resourceId),expiresIn:90};
  }
  app.get('/api/v1/voice/capabilities',async req=>{requireIdentity(req);return {asr:asrAvailable(),tts:ttsAvailable(),ready:asrAvailable()&&ttsAvailable(),transport:'wechat-recorder-cloud',message:asrAvailable()&&ttsAvailable()?'语音服务已配置，实际连通性以开始后的结果为准':'云端语音尚未完整配置'};});
  app.post('/api/v1/patient/followups/:id/speech',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async req=>{
    const i=requireIdentity(req,'patient');const id=idSchema.parse((req.params as any).id);const b=z.object({expectedVersion:z.number().int().positive(),summary:z.boolean().optional()}).strict().parse(req.body);
    return audioFor(i,id,b.expectedVersion,b.summary);
  });
  app.post('/api/v1/patient/followups/:id/voice-ticket',async req=>{
    const i=requireIdentity(req,'patient');const id=idSchema.parse((req.params as any).id);const s=await ownedSession(db,i,id);
    if(!asrAvailable()||!ttsAvailable())throw unavailable('请先配置云端语音识别与语音合成');
    if(!['active','awaiting_confirmation'].includes(s.status))throw conflict('请先恢复未结束的随访');
    return {ticket:await issueTicket(db,i,s,'socket'),socketPath:'/api/v1/voice/socket',expiresIn:90};
  });
  app.get('/api/v1/voice/audio/:id',async(req,reply)=>{
    const i=requireIdentity(req,'patient');const id=idSchema.parse((req.params as any).id);const token=String(req.headers['x-audio-ticket']||'');
    const resource=resources.get(id);if(!resource||resource.expires<Date.now()||resource.accountId!==i.accountId)throw notFound();
    await consumeTicket(db,token,'audio',i.accountId,id,config.nodeEnv!=='production');
    return reply.type('audio/mpeg').header('content-length',resource.bytes.length).send(resource.bytes);
  });

  app.get('/api/v1/voice/socket',{websocket:true},(socket,req)=>{
    let identity:Identity|null=null;let sessionId='';let sequence=0;let closed=false;let upstream:AsrConnection|null=null;
    let recording=false;let processing=false;let ending=false;let starting:Promise<void>|null=null;let byteCount=0;let queued:Buffer[]=[];
    let currentVersion=0;let playbackGeneration=0;let requestKey='';
    let endTimer:ReturnType<typeof setTimeout>|undefined;let recordingTimer:ReturnType<typeof setTimeout>|undefined;let stopWatchdog:ReturnType<typeof setTimeout>|undefined;
    const emit=(type:string,data:Record<string,any>={})=>{if(!closed&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type,sessionId,sequence:++sequence,...data}));};
    const clearTimers=()=>{clearTimeout(endTimer);clearTimeout(recordingTimer);clearTimeout(stopWatchdog);};
    const fail=(message='语音连接暂不可用，请重新开始')=>{emit('error',{message,retryable:true});clearTimers();upstream?.close();upstream=null;socket.close(1008,'voice paused');};
    const stopRequested=()=>{clearTimeout(endTimer);emit('audio.stop_requested');stopWatchdog=setTimeout(()=>fail('录音未完整结束，请重新开始'),7000);};
    async function speak(session:any) {
      const generation=++playbackGeneration;
      emit('assistant.text',{session});
      const audio=await audioFor(identity!,sessionId,session.version);
      if(generation!==playbackGeneration||closed||recording)return;
      emit('assistant.audio.ready',{audio,session});
    }
    async function startAudio(version:number) {
      if(!identity||recording||processing)throw conflict('上一句仍在处理中');
      // Begin buffering immediately, before authorization/ASR network awaits.
      currentVersion=version;++playbackGeneration;recording=true;ending=false;byteCount=0;queued=[];requestKey=randomUUID();
      const auth=await db.query('SELECT 1 FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT a.disabled',[identity.sessionId]);
      if(!auth.rowCount)throw new AppError(401,'UNAUTHENTICATED','登录已过期，请重新登录');
      const s=await ownedSession(db,identity,sessionId);if(s.version!==version||!['active','awaiting_confirmation'].includes(s.status))throw conflict();
      clearTimers();recordingTimer=setTimeout(stopRequested,60000);
      const listener=(event:any)=>{
        if(closed||!recording)return;
        if(event.type==='error'){fail('语音识别暂不可用，请重新说一次');return;}
        if(event.type==='speech'||event.type==='partial'){clearTimeout(endTimer);if(event.type==='partial')emit('transcript.partial',{text:event.text});}
        if(event.type==='sentence'){emit('transcript.partial',{text:event.text});clearTimeout(endTimer);endTimer=setTimeout(stopRequested,1100);}
      };
      upstream=providers.asr?.connect?await providers.asr.connect(listener):await connectAsr(config,listener);
      if(closed){upstream!.close();return;}
      for(const chunk of queued)upstream!.send(chunk);queued=[];emit('listening');
    }
    async function finishAudio() {
      if(!identity||!recording||ending)return;ending=true;clearTimers();if(starting)await starting;
      const text=(await upstream!.finish()).trim();upstream=null;recording=false;
      if(!text){ending=false;throw unavailable('没有听清，请重新说一次');}
      if(text.length>1000)throw conflict('这句话较长，请分成短句回答');
      emit('transcript.final',{text});emit('turn.processing');processing=true;
      try{
        const session=await service.message(identity,sessionId,{clientMessageId:requestKey,text,expectedVersion:currentVersion,source:'voice'});
        if(closed)return;processing=false;ending=false;await speak(session);
      }finally{processing=false;}
    }
    socket.on('message',(raw,binary)=>{
      if(!identity||closed)return;
      if(binary){
        if(!recording||ending)return;const bytes=Buffer.from(raw as Buffer);byteCount+=bytes.length;if(byteCount>2_100_000){fail('这一段录音较长，请分成短句回答');return;}
        try{if(upstream)upstream.send(bytes);else queued.push(bytes);}catch{fail();}return;
      }
      let message:any;try{message=JSON.parse(raw.toString());}catch{fail('语音消息格式无效');return;}
      const handle=async()=>{
        if(message.type==='audio.start'){
          if(starting||recording||processing)throw conflict('上一段语音仍在处理中');
          starting=startAudio(z.number().int().positive().parse(message.expectedVersion));try{await starting;}finally{starting=null;}
        }else if(message.type==='audio.end')await finishAudio();
        else if(message.type==='assistant.replay'){
          if(recording||processing)throw conflict('请先暂停录音');const s=await service.view(identity!,sessionId);
          if(s.version!==message.expectedVersion)throw conflict();await speak(s);
        }else if(message.type==='pause'){await service.pause(identity!,sessionId);socket.close();}
      };
      void handle().catch(e=>fail(e instanceof AppError?e.message:'语音暂未完成，请重试或查看文字'));
    });
    socket.on('close',()=>{closed=true;clearTimers();upstream?.close();if(identity&&active.get(identity.accountId)===socket){active.delete(identity.accountId);void service.pause(identity,sessionId).catch(()=>{});}});
    socket.on('error',()=>{upstream?.close();});
    void(async()=>{
      try{
        const ticket=await consumeTicket(db,String(req.headers['x-voice-ticket']||''),'socket',undefined,undefined,config.nodeEnv!=='production');
        if(closed)return;if(active.has(ticket.account_id)||active.size>=8)throw conflict('已有语音正在进行，或服务正忙，请稍后再试');
        identity={accountId:ticket.account_id,sessionId:ticket.auth_session_id,role:'patient',kind:'patient',csrfToken:null,displayName:ticket.display_name};
        sessionId=ticket.session_id;currentVersion=ticket.version;active.set(identity.accountId,socket);emit('session.ready',{session:await service.view(identity,sessionId)});
      }catch(e){fail(e instanceof AppError?e.message:'语音连接凭证失效，请重试');}
    })();
  });
  return {audioFor};
}
