import { encodeWav, SilenceSegmenter } from './pcm.js';

export class PcmRecorder {
  constructor(private workletUrl=import.meta.env.BASE_URL+'pcm-worklet.js'){}
  private context?: AudioContext;private stream?:MediaStream;private source?:MediaStreamAudioSourceNode;private node?:AudioWorkletNode;private mute?:GainNode;
  private active=false;private frames:Float32Array[]=[];private count=0;private detector?:SilenceSegmenter;private voiced=false;
  private segment?: (blob:Blob)=>void;private failure?:(e:Error)=>void;private level?:(n:number)=>void;private permissionEpoch=0;
  async prepare(){
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('请在 HTTPS 网站或本机浏览器中使用麦克风。');
    if(this.source&&this.node&&this.mute&&this.stream?.getAudioTracks().some(t=>t.readyState==='live')&&this.stream.getTracks().every(t=>t.readyState==='live')&&this.context&&this.context.state!=='closed'){
      const epoch=this.permissionEpoch;const context=this.context;
      try{await context.resume();return;}catch(error){if(epoch===this.permissionEpoch)this.release();throw error;}
    }
    const epoch=++this.permissionEpoch;
    this.releaseResources();
    try{
      const AudioContextClass=globalThis.AudioContext||(window as Window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!AudioContextClass)throw new Error('此浏览器没有网页录音能力，请在手机的独立浏览器中打开。');
      this.context=new AudioContextClass();
      const context=this.context;
      await context.resume();
      if(epoch!==this.permissionEpoch)return;
      if(!context.audioWorklet||typeof AudioWorkletNode==='undefined')throw new Error('此浏览器的录音组件不可用，请更新浏览器，或从微信右上角选择在其他浏览器打开。');
      let stream:MediaStream;
      try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}
      catch(e){if((e as DOMException).name==='NotAllowedError')throw new Error('麦克风权限未开启。请在浏览器的网站权限中允许麦克风，再点重试。');throw new Error('无法打开麦克风，请检查设备是否被其他应用占用，再点重试。');}
      if(epoch!==this.permissionEpoch){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      stream.getAudioTracks().forEach(t=>{t.enabled=false;});
      await context.audioWorklet.addModule(this.workletUrl);
      if(epoch!==this.permissionEpoch)return;
      this.source=context.createMediaStreamSource(stream);this.node=new AudioWorkletNode(context,'patient-pcm');this.mute=context.createGain();this.mute.gain.value=0;
      this.source.connect(this.node);this.node.connect(this.mute);this.mute.connect(context.destination);
      this.node.port.onmessage=(event:MessageEvent<Float32Array>)=>{if(epoch===this.permissionEpoch)this.receive(new Float32Array(event.data));};
      for(const track of stream.getTracks())track.onended=()=>{if(epoch===this.permissionEpoch&&this.active){this.cancel();this.failure?.(new Error('麦克风已中断。请回到页面后点重试 / 恢复。'));}};
      context.onstatechange=()=>{if(epoch===this.permissionEpoch&&this.active&&context.state!=='running'){this.cancel();this.failure?.(new Error('录音被系统暂停。请回到页面后点重试 / 恢复。'));}};
    }catch(error){if(epoch===this.permissionEpoch)this.release();throw error;}
  }
  start(segment:(blob:Blob)=>void,level:(n:number)=>void,failure:(e:Error)=>void){
    this.cancel();this.segment=segment;this.level=level;this.failure=failure;
    if(!this.source||!this.node||!this.mute||!this.context||this.context.state!=='running'||!this.stream?.getAudioTracks().some(t=>t.readyState==='live')){failure(new Error('麦克风未就绪，请点重试 / 恢复。'));return;}
    this.detector=new SilenceSegmenter(this.context.sampleRate);this.active=true;this.stream.getAudioTracks().forEach(t=>{t.enabled=true;});
  }
  private receive(frame:Float32Array){
    if(!this.active||!this.context||!this.detector)return;
    this.frames.push(frame);this.count+=frame.length;const sample=this.detector.push(frame);this.voiced=sample.voiced;this.level?.(sample.level);
    if(sample.finish)this.finish();
  }
  finish(){
    if(!this.active||!this.context)return;
    const voiced=this.voiced;const frames=this.frames;const count=this.count;const callback=this.segment;const rate=this.context.sampleRate;
    this.cancel();
    if(!voiced){this.failure?.(new Error('没有听到清晰的语音，请点重试 / 恢复后靠近麦克风说话。'));return;}
    const samples=new Float32Array(count);let offset=0;for(const frame of frames){samples.set(frame,offset);offset+=frame.length;}
    callback?.(new Blob([encodeWav(samples,rate)],{type:'audio/wav'}));
  }
  cancel(){this.active=false;this.frames=[];this.count=0;this.voiced=false;this.detector=undefined;this.stream?.getAudioTracks().forEach(t=>{t.enabled=false;});this.level?.(0);}
  private releaseResources(){this.cancel();this.node?.disconnect();this.source?.disconnect();this.mute?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());if(this.context&&this.context.state!=='closed')void this.context.close().catch(()=>{});this.source=undefined;this.node=undefined;this.mute=undefined;this.stream=undefined;this.context=undefined;}
  release(){++this.permissionEpoch;this.releaseResources();}
}
