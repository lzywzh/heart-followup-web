import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserSpeaker} from '../src/voice/speaker.js';
import type {Session} from '../src/types.js';
const session={id:'test',version:1,status:'active',turns:[]} as Session;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function latch<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

async function device(run:(h:{contexts:any[];sources:any[]})=>Promise<void>){
  const descriptors=new Map(['window','AudioContext'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const contexts:any[]=[],sources:any[]=[];
  class Source{
    onended?:()=>void;buffer?:unknown;started=false;stopped=false;
    constructor(){sources.push(this);}connect(){}disconnect(){}start(){this.started=true;}stop(){this.stopped=true;this.onended?.();}
  }
  class Context{
    state='suspended';destination={};resumes=0;constructor(){contexts.push(this);}
    resume(){this.resumes++;this.state='running';return Promise.resolve();}
    createBuffer(){return {};}
    createBufferSource(){return new Source();}
    decodeAudioData=async(_bytes:ArrayBuffer)=>({duration:1});
    close=async()=>{this.state='closed';};
  }
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioContext:Context,speechSynthesis:undefined}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});
  try{await run({contexts,sources});}finally{for(const [key,value] of descriptors){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
}

test('server voice works without SpeechSynthesis and unlocks Web Audio inside the click',async()=>{
  await device(async({contexts,sources})=>{
    let requested=false;
    const speaker=new BrowserSpeaker(async()=>{requested=true;return new Blob(['RIFF'],{type:'audio/wav'});});
    speaker.mode='server' as any;
    const preparation=speaker.prepare();
    assert.equal(contexts.length,1,'the audio context must exist before yielding the click handler');
    assert.equal(contexts[0].resumes,1,'playback must be unlocked before network work');
    await preparation;
    const spoken=speaker.speak('您好',session);await tick();
    assert.equal(requested,true);assert.ok(sources.at(-1).started);
    sources.at(-1).onended();await spoken;speaker.cancel();
  });
});

test('cancelled decoding cannot play old audio over the next server question',async()=>{
  await device(async({contexts,sources})=>{
    const speaker=new BrowserSpeaker(async()=>new Blob(['RIFF'],{type:'audio/wav'}));speaker.mode='server' as any;
    await speaker.prepare();const decoding=latch<any>();contexts[0].decodeAudioData=()=>decoding.promise;
    const old=speaker.speak('旧问题',session);await tick();speaker.cancel();await old;
    const before=sources.length;decoding.resolve({duration:1});await tick();
    assert.equal(sources.length,before,'a cancelled decode must never create a playback source');
    contexts[0].decodeAudioData=async()=>({duration:1});
    const current=speaker.speak('当前问题',session);await tick();
    assert.ok(sources.at(-1).started);sources.at(-1).onended();await current;speaker.cancel();
  });
});
