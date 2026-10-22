import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '@heart/contracts';
import { AppError, conflict, unavailable } from '../errors.js';
import { assertActiveSession, requireIdentity, type Context } from '../modules/context.js';
import { createFollowupService, ownedSession, patientSessionView } from '../followups/service.js';
import { GREETING } from '../agents/protocol.js';
import { createLocalAsr, validateWav } from './local-asr.js';
import { createLocalTts } from './local-tts.js';
import { synthesize } from './tts.js';

const requestSchema = z.object({ expectedVersion: z.coerce.number().int().positive(), clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const asrFor = (context: Context) => context.providers.localAsr || createLocalAsr(context.config.localAsrUrl || '');
const ttsFor = (context: Context) => context.providers.localTts || createLocalTts(context.config.localTtsUrl || '');

export async function browserCapabilities(context: Context) {
  let asr = false;
  try { asr = (await asrFor(context).status()).available === true; } catch { /* A failed health check is unavailable. */ }
  const cloudConfigured = Boolean(context.providers.tts || (context.config.dashscopeApiKey && context.config.dashscopeUrl));
  const mode = context.config.voiceTtsMode || 'browser';
  const ttsMode = mode === 'server' ? 'server' : mode === 'cloud' || (mode === 'auto' && cloudConfigured) ? 'cloud' : 'browser';
  let localAvailable=false;
  if(ttsMode==='server')try{localAvailable=(await ttsFor(context).status()).available===true;}catch{ /* Configuration alone is not readiness. */ }
  const ttsAvailable=ttsMode==='server'?localAvailable:cloudConfigured;
  return {
    asr, tts: ttsMode === 'browser' ? null : ttsAvailable, ttsMode,
    ready: asr && (ttsMode === 'browser' || ttsAvailable),
    asrStatus: asr ? 'available' : 'unavailable', ttsStatus: ttsMode === 'browser' ? 'device-check-required' : ttsMode==='server' ? localAvailable?'available':'unavailable' : cloudConfigured ? 'configured-unchecked' : 'unconfigured',
    message: !asr ? '语音识别暂未就绪，请稍后重试' : ttsMode==='server' ? localAvailable?'使用服务器中文语音，点击开始后检查麦克风与音频播放':'服务器声音暂未就绪，请稍后重试' : ttsMode === 'browser' ? '使用当前设备的中文朗读声音，开始前会检查麦克风和播放能力' : '云语音已配置，实际播放和连通性需在开始后验证',
  };
}

export async function registerBrowserVoice(context: Context) {
  const { app, db, config, providers } = context;
  const service = createFollowupService(context); const asr = asrFor(context); const localTts=ttsFor(context);
  const audioCache = new Map<string, { bytes: Buffer; expires: number }>();
  const inflightSpeech = new Map<string, Promise<Buffer>>();
  app.addContentTypeParser(['audio/wav', 'audio/x-wav'], { parseAs: 'buffer', bodyLimit: 810000 }, (_req, body, done) => done(null, body));
  app.addHook('onClose', async () => { audioCache.clear(); inflightSpeech.clear(); });

  app.get('/api/v1/patient/voice/capabilities', async req => { requireIdentity(req, 'patient'); return browserCapabilities(context); });
  app.get('/api/v1/clinician/voice/capabilities', async req => { requireIdentity(req, 'clinician'); return browserCapabilities(context); });

  app.post('/api/v1/patient/followups/:id/audio', { bodyLimit: 810000, config: { rateLimit: { max: 24, timeWindow: '1 minute' } } }, async req => {
    const identity = requireIdentity(req, 'patient'); const id = idSchema.parse((req.params as any).id); const input = requestSchema.parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new AppError(400, 'INVALID_AUDIO', '没有收到有效录音，请重试');
    const bytes = req.body; const {durationMs} = validateWav(bytes); const payloadHash = createHash('sha256').update(bytes).digest('hex');
    const claim = await db.transaction(async tx => {
      await assertActiveSession(tx, identity, true, config.nodeEnv === 'production');
      const session = await ownedSession(tx, identity, id, true);
      const existing = (await tx.query('SELECT * FROM browser_audio_requests WHERE session_id=$1 AND client_message_id=$2 FOR UPDATE', [id, input.clientMessageId])).rows[0];
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.expected_version !== input.expectedVersion) throw conflict('这条录音编号已用于其他内容，请重新录音');
        if (existing.status === 'completed') return { cached: true as const, response: {...existing.response,session:await patientSessionView(tx,session)} };
        if (existing.status === 'processing' && new Date(existing.lease_until) > new Date()) throw new AppError(409, 'VOICE_PROCESSING', '这句话仍在处理，请稍等后重试');
      }
      const turn = (await tx.query('SELECT * FROM followup_turns WHERE session_id=$1 AND client_message_id=$2', [id, input.clientMessageId])).rows[0];
      if (turn?.status === 'completed') {
        if(!existing)throw conflict('这条消息编号已被使用，请重新录音');
        const response = {session:await patientSessionView(tx, session),transcript:turn.patient_text,timing:turn.timing};
        await tx.query("UPDATE browser_audio_requests SET status='completed',response=$1,transcript=$2,lease_until=NULL,updated_at=now() WHERE id=$3", [response, turn.patient_text, existing.id]);
        return {cached:true as const,response};
      }
      if (!['active','awaiting_confirmation'].includes(session.status)) throw conflict('请先继续未结束的随访');
      if (session.version !== (turn?.session_version || input.expectedVersion)) throw conflict('随访内容已改变，请重新加载后继续');
      const pending = await tx.query("SELECT id FROM browser_audio_requests WHERE session_id=$1 AND status='processing' AND lease_until>now() AND client_message_id<>$2", [id, input.clientMessageId]);
      if (pending.rowCount) throw new AppError(409,'VOICE_PROCESSING','上一句话还在处理，请稍等');
      const token = randomUUID(); const requestId = existing?.id || randomUUID();
      if (existing) await tx.query("UPDATE browser_audio_requests SET status='processing',attempt_token=$1,lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=$2",[token,requestId]);
      else await tx.query("INSERT INTO browser_audio_requests(id,session_id,account_id,client_message_id,expected_version,payload_hash,status,attempt_token,lease_until) VALUES($1,$2,$3,$4,$5,$6,'processing',$7,now()+interval '90 seconds')",[requestId,id,identity.accountId,input.clientMessageId,input.expectedVersion,payloadHash,token]);
      return { cached: false as const, requestId, token, transcript: existing?.transcript as string | null };
    });
    if (claim.cached) return claim.response;
    const started = Date.now(); let asrMs = 0;
    try {
      const transcript = claim.transcript || String(await asr.transcribe(bytes, 'audio/wav')).trim();
      asrMs = Date.now() - started;
      if (!transcript) throw new AppError(422,'NO_SPEECH','没有听清这句话，请重新说一次');
      if (transcript.length > 1000) throw new AppError(422,'SPEECH_TOO_LONG','这句话有些长，请分成短句回答');
      await db.transaction(async tx => {
        await assertActiveSession(tx,identity,true,config.nodeEnv==='production');
        const current=(await tx.query('SELECT status,attempt_token,lease_until FROM browser_audio_requests WHERE id=$1 FOR UPDATE',[claim.requestId])).rows[0];
        if(current?.status!=='processing'||current.attempt_token!==claim.token||new Date(current.lease_until)<=new Date())throw conflict('录音处理已过期，请重试');
        await tx.query('UPDATE browser_audio_requests SET transcript=$1,updated_at=now() WHERE id=$2',[transcript,claim.requestId]);
      });
      const session = await service.message(identity,id,{clientMessageId:input.clientMessageId,expectedVersion:input.expectedVersion,text:transcript,source:'voice',audioRequest:{id:claim.requestId,token:claim.token}});
      const response = {session,transcript,timing:{durationMs,asrMs,totalMs:Date.now()-started}};
      await db.transaction(async tx => {
        await assertActiveSession(tx,identity,true,config.nodeEnv==='production');
        const updated=await tx.query("UPDATE browser_audio_requests SET status='completed',response=$1,lease_until=NULL,updated_at=now() WHERE id=$2 AND attempt_token=$3 AND status='processing' RETURNING id",[response,claim.requestId,claim.token]);
        if(!updated.rowCount)throw conflict('这段录音已由新的处理接管，请刷新查看');
      });
      return {...response,session:await service.view(identity,id)};
    } catch(error) {
      await db.query("UPDATE browser_audio_requests SET status='failed',lease_until=NULL,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND status='processing'",[claim.requestId,claim.token]);
      throw error;
    }
  });

  app.post('/api/v1/patient/followups/:id/end-call', async req => {
    const identity = requireIdentity(req,'patient'); const id=idSchema.parse((req.params as any).id); const input=versionSchema.parse(req.body);
    return service.submit(identity,id,{expectedVersion:input.expectedVersion,confirmed:false});
  });

  app.post('/api/v1/patient/followups/:id/browser-speech',{config:{rateLimit:{max:24,timeWindow:'1 minute'}}},async(req,reply)=>{
    const identity=requireIdentity(req,'patient');const id=idSchema.parse((req.params as any).id);
    const input=versionSchema.extend({summary:z.boolean().optional()}).strict().parse(req.body);
    await assertActiveSession(db,identity,false,config.nodeEnv==='production');
    const session=await service.view(identity,id);if(session.version!==input.expectedVersion)throw conflict();
    const caps=await browserCapabilities(context);if(caps.ttsMode==='browser'||!caps.tts)throw unavailable(caps.ttsMode==='browser'?'当前使用设备朗读，请在浏览器中播放':'声音服务暂未就绪，请稍后重试');
    const text=input.summary?session.briefSummary.title+'。'+session.briefSummary.items.map(v=>`${v.label}，${v.value}。`).join(''):session.turns.filter(t=>t.status==='completed').at(-1)?.assistantText||GREETING;
    const key=createHash('sha256').update(caps.ttsMode+'|'+config.ttsModel+'|'+config.ttsVoice+'|'+text).digest('hex');
    let entry=audioCache.get(key);let bytes:Buffer;
    if(entry&&entry.expires>Date.now())bytes=entry.bytes;
    else {
      let pending=inflightSpeech.get(key);
      if(!pending){pending=caps.ttsMode==='server'?localTts.synthesize(text):providers.tts?providers.tts.synthesize(text):synthesize(config,text);inflightSpeech.set(key,pending!);}
      try {bytes=await pending!;}finally{inflightSpeech.delete(key);}
      if(!bytes.length||bytes.length>4_000_000)throw unavailable('语音未完整生成，请重试');
      if(audioCache.size>=30)audioCache.delete(audioCache.keys().next().value!);
      audioCache.set(key,{bytes,expires:Date.now()+180000});
    }
    await assertActiveSession(db,identity,false,config.nodeEnv==='production');
    const current=await ownedSession(db,identity,id);if(current.version!==input.expectedVersion)throw conflict();
    return reply.type(caps.ttsMode==='server'?'audio/wav':'audio/mpeg').header('cache-control','no-store').header('content-length',bytes.length).send(bytes);
  });
}
