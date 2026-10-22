import WebSocket from 'ws';
import { createHmac,randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { unavailable } from '../errors.js';

type AsrEvent={type:'started'|'speech'|'partial'|'sentence'|'error';text?:string};
export interface AsrConnection {send(data:Buffer):void;finish():Promise<string>;close():void;}
const tokenCache=new Map<string,{token:string;expires:number}>();
const escape=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export async function getAsrToken(config:AppConfig) {
  if(!config.aliyunAccessKeyId||!config.aliyunAccessKeySecret)throw unavailable('云端语音识别尚未配置');
  const cached=tokenCache.get(config.aliyunAccessKeyId);if(cached&&cached.expires>Date.now()+120000)return cached.token;
  const params:Record<string,string>={AccessKeyId:config.aliyunAccessKeyId,Action:'CreateToken',Format:'JSON',RegionId:'cn-shanghai',SignatureMethod:'HMAC-SHA1',SignatureNonce:randomUUID(),SignatureVersion:'1.0',Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),Version:'2019-02-28'};
  const canonical=Object.keys(params).sort().map(k=>`${escape(k)}=${escape(params[k])}`).join('&');
  const signature=createHmac('sha1',config.aliyunAccessKeySecret+'&').update('GET&%2F&'+escape(canonical)).digest('base64');
  try{
    const response=await fetch('https://nls-meta.cn-shanghai.aliyuncs.com/?'+canonical+'&Signature='+escape(signature),{signal:AbortSignal.timeout(10000)});
    const data=await response.json() as any;if(!response.ok||!data.Token?.Id)throw new Error();
    tokenCache.set(config.aliyunAccessKeyId,{token:data.Token.Id,expires:Number(data.Token.ExpireTime)*1000});return data.Token.Id as string;
  }catch{throw unavailable('语音识别授权暂未成功，请检查服务配置');}
}
export async function connectAsr(config:AppConfig,onEvent:(e:AsrEvent)=>void,tokenProvider=()=>getAsrToken(config)):Promise<AsrConnection>{
  if(!config.aliyunAsrAppKey)throw unavailable('云端语音识别 AppKey 尚未配置');
  if(config.nodeEnv==='production'&&!config.aliyunAsrUrl.startsWith('wss://'))throw unavailable('语音识别连接必须使用 WSS');
  const token=await tokenProvider();const taskId=randomUUID().replaceAll('-','');const results=new Map<number,string>();
  const socket=new WebSocket(config.aliyunAsrUrl,{headers:{'X-NLS-Token':token},handshakeTimeout:10000,maxPayload:1_000_000});
  let readyResolve:()=>void=()=>{};let readyReject:(e:Error)=>void=()=>{};let finalResolve:((s:string)=>void)|null=null;let finalReject:((e:Error)=>void)|null=null;
  let completed=false;let closed=false;let finishPromise:Promise<string>|null=null;let finishTimer:ReturnType<typeof setTimeout>|undefined;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const startTimer=setTimeout(()=>fail(),12000);
  const joined=()=>[...results.entries()].sort((a,b)=>a[0]-b[0]).map(([,text])=>text).join('');
  function command(name:string,payload?:any){socket.send(JSON.stringify({header:{message_id:randomUUID().replaceAll('-',''),task_id:taskId,namespace:'SpeechTranscriber',name,appkey:config.aliyunAsrAppKey},...(payload?{payload}:{})}));}
  function fail(){if(closed)return;closed=true;clearTimeout(startTimer);clearTimeout(finishTimer);const e=unavailable('没有识别到完整语音，请重新说一次');readyReject(e);finalReject?.(e);onEvent({type:'error'});socket.close();}
  socket.on('open',()=>command('StartTranscription',{format:'pcm',sample_rate:16000,enable_intermediate_result:true,enable_punctuation_prediction:true,enable_inverse_text_normalization:true,max_sentence_silence:800}));
  socket.on('message',raw=>{
    let m:any;try{m=JSON.parse(raw.toString());}catch{return fail();}
    if(m.header?.status&&m.header.status!==20000000)return fail();
    const name=m.header?.name;
    if(name==='TranscriptionStarted'){clearTimeout(startTimer);readyResolve();onEvent({type:'started'});}
    if(name==='SentenceBegin')onEvent({type:'speech'});
    if(name==='TranscriptionResultChanged')onEvent({type:'partial',text:m.payload?.result||''});
    if(name==='SentenceEnd'){results.set(Number(m.payload?.index||results.size+1),String(m.payload?.result||''));onEvent({type:'sentence',text:joined()});}
    if(name==='TranscriptionCompleted'){completed=true;clearTimeout(finishTimer);finalResolve?.(joined());socket.close();}
    if(name==='TaskFailed')fail();
  });
  socket.on('error',fail);socket.on('close',()=>{if(!completed&&!closed)fail();});
  await ready;
  return {
    send(data){if(socket.readyState!==WebSocket.OPEN||closed)throw unavailable('语音连接已断开');socket.send(data);},
    finish(){if(completed)return Promise.resolve(joined());if(finishPromise)return finishPromise;finishPromise=new Promise<string>((resolve,reject)=>{finalResolve=resolve;finalReject=reject;finishTimer=setTimeout(fail,7000);command('StopTranscription');});return finishPromise;},
    close(){if(closed)return;closed=true;clearTimeout(startTimer);clearTimeout(finishTimer);finalReject?.(unavailable('语音已暂停'));socket.close();},
  };
}
