import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { unavailable } from '../errors.js';

export async function synthesize(config:AppConfig,text:string):Promise<Buffer> {
  if(!config.dashscopeApiKey||!config.dashscopeUrl)throw unavailable('云端语音合成尚未配置');
  if(config.nodeEnv==='production'&&!config.dashscopeUrl.startsWith('wss://'))throw unavailable('语音合成连接必须使用 WSS');
  if(!text.trim()||text.length>2000)throw unavailable('待播放内容不合适');
  return new Promise((resolve,reject)=>{
    const id=randomUUID().replaceAll('-','');const chunks:Buffer[]=[];let size=0;let settled=false;
    const socket=new WebSocket(config.dashscopeUrl,{headers:{Authorization:`Bearer ${config.dashscopeApiKey}`},handshakeTimeout:10000,maxPayload:4_000_000});
    const timer=setTimeout(()=>end(undefined,new Error('timeout')),20000);
    function end(audio?:Buffer,error?:Error){if(settled)return;settled=true;clearTimeout(timer);socket.close();error?reject(unavailable('语音合成暂不可用，请重试或查看文字')):resolve(audio!);}
    function send(action:string,payload:any){socket.send(JSON.stringify({header:{action,task_id:id,streaming:'duplex'},payload}));}
    socket.on('open',()=>send('run-task',{task_group:'audio',task:'tts',function:'SpeechSynthesizer',model:config.ttsModel,parameters:{text_type:'PlainText',voice:config.ttsVoice,format:'mp3',sample_rate:22050,volume:50,rate:1,pitch:1},input:{}}));
    socket.on('message',(raw,binary)=>{
      if(settled)return;
      if(binary){const b=Buffer.from(raw as Buffer);size+=b.length;if(size>4_000_000)return end(undefined,new Error('too large'));chunks.push(b);return;}
      let event:any;try{event=JSON.parse(raw.toString());}catch{return end(undefined,new Error('invalid response'));}
      if(event.header?.task_id&&event.header.task_id!==id)return;
      if(event.header?.event==='task-started'){send('continue-task',{input:{text}});send('finish-task',{input:{}});}
      if(event.header?.event==='task-failed')end(undefined,new Error('failed'));
      if(event.header?.event==='task-finished'){if(!size)return end(undefined,new Error('empty audio'));end(Buffer.concat(chunks));}
    });
    socket.on('error',()=>end(undefined,new Error('connection failed')));
    socket.on('close',()=>{if(!settled)end(undefined,new Error('closed'));});
  });
}
