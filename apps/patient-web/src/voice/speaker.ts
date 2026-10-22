import type { Session } from '../types.js';
import {chineseVoice} from './voices.js';
export class BrowserSpeaker {
  voiceName='';mode:'browser'|'cloud'|'server'='browser';
  private voice?:SpeechSynthesisVoice;private settle?:()=>void;private abort?:AbortController;private context?:AudioContext;private source?:AudioBufferSourceNode;
  constructor(private cloud:(s:Session,signal:AbortSignal)=>Promise<Blob>){}
  private selectVoice(){
    this.voice=chineseVoice(window.speechSynthesis.getVoices());this.voiceName=this.voice?.name||'';return Boolean(this.voice);
  }
  async prepare(){
    if(this.mode!=='browser'){
      const AudioContextClass=window.AudioContext||(window as Window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!AudioContextClass)throw new Error('此浏览器没有音频播放能力，请在手机的独立浏览器中打开。');
      if(!this.context||this.context.state==='closed')this.context=new AudioContextClass();
      const context=this.context;
      // Resume and start a silent sample synchronously in the click handler, before any fetch.
      const resumed=context.resume();const unlock=context.createBufferSource();unlock.buffer=context.createBuffer(1,1,context.sampleRate||16000);
      unlock.connect(context.destination);unlock.onended=()=>unlock.disconnect();unlock.start(0);
      await resumed;
      if(context.state!=='running')throw new Error('浏览器暂停了声音，请保持页面在前台并点重试 / 恢复。');
      return;
    }
    if(!('speechSynthesis'in window)||!('SpeechSynthesisUtterance'in window))throw new Error('此浏览器没有语音播报能力，请使用支持中文语音的系统浏览器。');
    const synth=window.speechSynthesis;synth.resume();
    // Prime playback while still inside the user gesture (required by mobile browsers).
    const unlock=new SpeechSynthesisUtterance(' ');unlock.volume=0;synth.speak(unlock);
    if(this.selectVoice())return;
    await new Promise<void>((resolve,reject)=>{
      const finish=()=>{if(this.selectVoice()){cleanup();resolve();}};
      const timer=setTimeout(()=>{cleanup();reject(new Error('没有找到简体中文声音。请在设备的语音设置中下载中文声音，再点重试。'));},2500);
      const cleanup=()=>{clearTimeout(timer);synth.removeEventListener('voiceschanged',finish);};synth.addEventListener('voiceschanged',finish);finish();
    });
  }
  speak(text:string,session:Session):Promise<void>{
    this.cancel();
    return new Promise<void>((resolve,reject)=>{
      let finished=false;let timer:ReturnType<typeof setTimeout>;
      const complete=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);this.settle=undefined;error?reject(error):resolve();};
      this.settle=()=>complete();
      timer=setTimeout(()=>{complete(new Error('语音播报超时，请点重试 / 恢复。'));this.cancel();},Math.min(90000,Math.max(20000,text.length*450)));
      if(this.mode==='browser'){
        if(!this.selectVoice()){complete(new Error('中文声音不可用，请检查系统语音设置后重试。'));return;}
        const utterance=new SpeechSynthesisUtterance(text);utterance.lang='zh-CN';utterance.voice=this.voice!;utterance.rate=.94;utterance.pitch=1;utterance.volume=1;
        utterance.onend=()=>complete();utterance.onerror=()=>complete(new Error('浏览器未能播报，请点重试 / 恢复；必要时检查媒体音量或换用系统浏览器。'));
        window.speechSynthesis.resume();window.speechSynthesis.speak(utterance);
      }else{
        const abort=new AbortController();this.abort=abort;
        void this.cloud(session,abort.signal).then(async blob=>{
          if(finished||abort.signal.aborted)return;
          const context=this.context;if(!context||context.state==='closed')throw new Error('声音尚未准备好，请点重试 / 恢复。');
          const bytes=await blob.arrayBuffer();if(finished||abort.signal.aborted)return;
          const buffer=await context.decodeAudioData(bytes);if(finished||abort.signal.aborted)return;
          if(context.state!=='running')await context.resume();if(finished||abort.signal.aborted)return;
          if(context.state!=='running')throw new Error('浏览器暂停了声音，请点重试 / 恢复。');
          const source=context.createBufferSource();source.buffer=buffer;this.source=source;source.connect(context.destination);
          source.onended=()=>{source.disconnect();if(this.source===source)this.source=undefined;complete();};source.start(0);
        }).catch(()=>{if(!finished)complete(new Error('声音播放未完成，请保持页面在前台，点重试 / 恢复。'));});
      }
    });
  }
  cancel(){this.settle?.();this.abort?.abort();this.abort=undefined;window.speechSynthesis?.cancel();const source=this.source;this.source=undefined;if(source){source.onended=null;try{source.stop();}catch{/* A completed buffer is already stopped. */}source.disconnect();}}
}
