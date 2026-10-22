import { AppError, unavailable } from '../errors.js';

export function createLocalTts(baseUrl:string,fetchImpl=fetch){
  const endpoint=baseUrl.replace(/\/$/,'');
  let cached:{available:boolean}|undefined;let checkedAt=0;
  return {
    async status():Promise<{available:boolean}>{
      if(!endpoint)return {available:false};
      if(cached&&Date.now()-checkedAt<3000)return cached;
      try{
        const response=await fetchImpl(endpoint+'/health',{signal:AbortSignal.timeout(2000)});
        cached={available:response.ok&&(await response.json() as any).ready===true};
      }catch{cached={available:false};}
      checkedAt=Date.now();return cached;
    },
    async synthesize(text:string):Promise<Buffer>{
      if(!endpoint)throw unavailable('服务器语音合成尚未连接，请联系管理员');
      if(!text.trim()||text.length>500)throw unavailable('本次播报内容过长，请联系医生核对记录');
      let response:Response;
      try{
        response=await fetchImpl(endpoint+'/synthesize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(25000)});
      }catch{throw unavailable('声音生成暂未响应，请点重试 / 恢复');}
      if(response.status===429)throw new AppError(429,'TTS_BUSY','声音生成正在处理其他请求，请稍后重试');
      if(!response.ok)throw unavailable('声音生成暂不可用，请点重试 / 恢复');
      if(Number(response.headers.get('content-length'))>4_000_000)throw unavailable('语音没有完整生成，请重试');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<44||bytes.length>4_000_000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)throw unavailable('语音格式不正确，请点重试 / 恢复');
      return bytes;
    },
  };
}
