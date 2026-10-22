import type { Session } from '../types.js';
export type VoiceState = 'ready' | 'authorizing' | 'speaking' | 'listening' | 'processing' | 'paused' | 'ending' | 'ended' | 'error';
export interface VoiceBoundaries {
  recorder: { prepare(): Promise<void>; start(segment: (blob: Blob) => void, level: (n:number) => void, failure: (e:Error) => void): void; finish(): void; cancel(): void; release(): void };
  speaker: { prepare(): Promise<void>; speak(text:string, session:Session): Promise<void>; cancel(): void };
  api: { upload(id:string,version:number,key:string,blob:Blob):Promise<{session:Session}>; get(id:string):Promise<Session>; pause(id:string):Promise<Session>; resume(id:string):Promise<Session>; end(id:string,version:number):Promise<Session> };
  changed():void; uuid():string;
}
const completed = (s:Session) => s.turns.some(t => t.status === 'completed' && t.patientText?.trim());
export class VoiceController {
  state: VoiceState = 'ready'; session?: Session; error = ''; level = 0; lastText = '';
  private epoch = 0; private generation=0; private work?: Promise<void>; private ending?: Promise<void>; private failedAudio?: {blob:Blob;key:string;version:number}; private disposed = false;
  constructor(private boundaries: VoiceBoundaries) {}
  private set(state:VoiceState) { this.state = state; this.boundaries.changed(); }
  private fail(e:unknown) { this.boundaries.recorder.cancel(); this.boundaries.speaker.cancel(); this.level=0; this.error=e instanceof Error?e.message:'语音暂时不可用，请重试'; this.set('error'); }
  async start(session:Session) {
    this.session=session; this.disposed=false; const epoch=++this.epoch; this.error=''; this.set('authorizing');
    try {
      await Promise.all([this.boundaries.recorder.prepare(),this.boundaries.speaker.prepare()]);
      if(epoch!==this.epoch||this.disposed)return;
      if(['submitted','handoff'].includes(session.status)){this.set('ended');return;}
      if(session.status==='paused')this.session=await this.boundaries.api.resume(session.id);
      if(epoch!==this.epoch)return;
      if(this.pending()){ this.error='上一句仍在处理中，请稍后点“重试 / 恢复”。'; this.set('error'); return; }
      await this.speak(epoch);
    } catch(e) { if(epoch===this.epoch)this.fail(e); }
  }
  private pending() { return this.session?.turns.some(t=>t.status==='pending') || this.session?.audioOperations?.some(t=>t.status==='processing'); }
  private async speak(epoch=this.epoch) {
    if(!this.session||epoch!==this.epoch||this.disposed)return;
    const turns=this.session.turns.filter(t=>t.status==='completed'&&!t.superseded&&t.assistantText);
    this.lastText=turns.at(-1)?.assistantText||this.session.greeting||'您好，请说说您今天的情况。';
    this.boundaries.recorder.cancel(); this.level=0; this.set('speaking');
    try { await this.boundaries.speaker.speak(this.lastText,this.session); if(epoch===this.epoch)this.listen(epoch); }
    catch(e){if(epoch===this.epoch)this.fail(e);}
  }
  private listen(epoch=this.epoch) {
    if(epoch!==this.epoch||this.disposed||!this.session)return;
    if(['submitted','handoff'].includes(this.session.status)){this.set('ended');this.boundaries.recorder.release();return;}
    this.set('listening');
    this.boundaries.recorder.start(blob=>{if(epoch===this.epoch&&this.state==='listening')this.accept(blob);},n=>{if(epoch===this.epoch){this.level=n;this.boundaries.changed();}},e=>{if(epoch===this.epoch)this.fail(e);});
  }
  private accept(blob:Blob) {
    if(!this.session||this.work)return;
    this.boundaries.recorder.cancel(); this.level=0;
    this.failedAudio={blob,key:this.boundaries.uuid(),version:this.session.version};
    this.set('processing'); this.work=this.upload(this.failedAudio);
  }
  private async upload(audio:{blob:Blob;key:string;version:number}) {
    const generation=this.generation;
    try {
      const result=await this.boundaries.api.upload(this.session!.id,audio.version,audio.key,audio.blob);
      if(this.disposed||generation!==this.generation)return;
      this.session=result.session; this.failedAudio=undefined; this.boundaries.changed();
      if(this.state==='processing')await this.speak();
    } catch(e){
      if(generation!==this.generation)return;
      if(['NO_SPEECH','SPEECH_TOO_LONG','INVALID_AUDIO'].includes((e as {code?:string})?.code||''))this.failedAudio=undefined;
      if(!this.disposed&&this.state!=='paused')this.fail(e);else if(!this.disposed){this.error=e instanceof Error?e.message:'上一句未完成，请重试';this.boundaries.changed();}
    }
    finally{if(generation===this.generation)this.work=undefined;}
  }
  finishSentence(){if(this.state==='listening')this.boundaries.recorder.finish();}
  async interrupt(){if(this.state!=='speaking')return; ++this.epoch;this.boundaries.speaker.cancel();this.listen();}
  async replay(){if(!['listening','speaking'].includes(this.state))return;++this.epoch;this.boundaries.speaker.cancel();this.boundaries.recorder.cancel();await this.speak();}
  async pause(){
    if(!this.session||['ended','ending','paused'].includes(this.state))return;
    const generation=this.generation;
    ++this.epoch;this.boundaries.recorder.cancel();this.boundaries.speaker.cancel();this.level=0;this.set('paused');
    try { const s=await this.boundaries.api.pause(this.session.id);if(!this.disposed&&generation===this.generation&&s.version>=this.session.version){this.session=s;this.boundaries.changed();} }
    catch(e){if(!this.disposed&&generation===this.generation)this.fail(e);}
  }
  async resume(){ if(!this.session||!['paused','error'].includes(this.state))return; await this.retry(); }
  async retry(){
    if(!this.session||this.work||this.ending)return;
    const epoch=++this.epoch;this.error='';this.set('authorizing');
    try{
      await Promise.all([this.boundaries.recorder.prepare(),this.boundaries.speaker.prepare()]);
      const current=await this.boundaries.api.get(this.session.id);if(epoch!==this.epoch)return;this.session=current;
      if(['submitted','handoff'].includes(current.status)){this.failedAudio=undefined;this.set('ended');return;}
      if(this.failedAudio&&current.turns.some(t=>t.clientMessageId===this.failedAudio!.key&&t.status==='completed'))this.failedAudio=undefined;
      if(current.status==='paused')this.session=await this.boundaries.api.resume(current.id);
      if(epoch!==this.epoch)return;
      if(this.failedAudio){this.set('processing');this.work=this.upload(this.failedAudio);await this.work;return;}
      if(this.pending())throw new Error('上一句仍在处理中，请稍后重试；本次记录已保留。');
      await this.speak(epoch);
    }catch(e){if(epoch===this.epoch)this.fail(e);}
  }
  end():Promise<void>{
    if(this.ending)return this.ending;
    if(!this.session||this.state==='ended')return Promise.resolve();
    if(this.state==='listening')this.boundaries.recorder.finish();
    ++this.epoch;this.boundaries.recorder.cancel();this.boundaries.speaker.cancel();this.level=0;this.set('ending');
    this.ending=this.finishEnd(this.generation);return this.ending;
  }
  private async finishEnd(generation:number){
    try{
      await this.work;
      if(this.disposed||generation!==this.generation)return;
      if(this.failedAudio)throw new Error('上一句尚未保存，请先重试 / 恢复，再结束通话。');
      if(!completed(this.session!))throw new Error('还没有收到有效回答，本次随访尚未完成。请恢复通话后说话。');
      const session=await this.boundaries.api.end(this.session!.id,this.session!.version);
      if(!this.disposed&&generation===this.generation){this.session=session;this.boundaries.recorder.release();this.set('ended');}
    }catch(e){if(!this.disposed&&generation===this.generation)this.fail(e);}
    finally{if(generation===this.generation)this.ending=undefined;}
  }
  dispose(){this.disposed=true;++this.epoch;++this.generation;this.work=undefined;this.ending=undefined;this.failedAudio=undefined;this.boundaries.recorder.release();this.boundaries.speaker.cancel();}
}
