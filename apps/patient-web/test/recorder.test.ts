import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmRecorder} from '../src/voice/recorder.js';
test('released microphone callbacks cannot inject PCM or fail a later microphone session',async()=>{
  const previous=new Map(['window','AudioContext','AudioWorkletNode'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const media=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');const nodes:any[]=[];const tracks:any[]=[];
  class Connection {connect(){}disconnect(){} gain={value:0};}
  class Context {state='running';sampleRate=16000;destination={};audioWorklet={addModule:async()=>{}};onstatechange?:()=>void;resume=async()=>{};close=async()=>{this.state='closed';};createGain=()=>new Connection();createMediaStreamSource=()=>new Connection();}
  class Node extends Connection {port={onmessage:undefined as any};constructor(){super();nodes.push(this);}}
  Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}});Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:Node});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{const track={readyState:'live',enabled:true,onended:undefined as any,stop(){this.readyState='ended';}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
  const recorder=new PcmRecorder('/synthetic-worklet.js');let levels=0;const errors:Error[]=[];
  try{
    await recorder.prepare();recorder.release();await recorder.prepare();recorder.start(()=>{},()=>{levels++;},e=>errors.push(e));
    const before=levels;nodes[0].port.onmessage({data:new Float32Array(1600).fill(.1)});tracks[0].onended();
    assert.equal(levels,before,'old PCM must not enter the new recorder');assert.deepEqual(errors,[]);
    nodes[1].port.onmessage({data:new Float32Array(1600).fill(.1)});assert.equal(levels,before+1,'current PCM must remain usable');
  }finally{recorder.release();for(const [key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}if(media)Object.defineProperty(navigator,'mediaDevices',media);else Reflect.deleteProperty(navigator,'mediaDevices');}
});

async function withFailingWorklet(run:(h:{recorder:PcmRecorder;tracks:any[];contexts:any[];nodes:any[]})=>Promise<void>,stage='worklet'){
  const previous=new Map(['window','AudioContext','AudioWorkletNode'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const media=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');const nodes:any[]=[];const tracks:any[]=[];const contexts:any[]=[];let failed=false;
  const fail=(current:string)=>{if(!failed&&stage===current){failed=true;throw new Error(current==='worklet'?'worklet load failed':current+' failed');}};
  class Connection {connect(){fail('connect');}disconnect(){} gain={value:0};}
  class Context {state='running';sampleRate=16000;destination={};onstatechange?:()=>void;constructor(){contexts.push(this);}audioWorklet={addModule:async()=>{fail('worklet');}};resume=async()=>{};close=async()=>{this.state='closed';};createGain=()=>{fail('gain');return new Connection();};createMediaStreamSource=()=>{fail('source');return new Connection();};}
  class Node extends Connection {port={onmessage:undefined as any};constructor(){super();fail('node');nodes.push(this);}}
  Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}});Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:Node});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{const track={readyState:'live',enabled:true,onended:undefined as any,stop(){this.readyState='ended';}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
  const recorder=new PcmRecorder('/synthetic-worklet.js');
  try{await run({recorder,tracks,contexts,nodes});}finally{recorder.release();for(const [key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}if(media)Object.defineProperty(navigator,'mediaDevices',media);else Reflect.deleteProperty(navigator,'mediaDevices');}
}

test('long initial silence stays listening with bounded pre-roll and preserves later intermittent speech',async()=>{
  await withFailingWorklet(async({recorder,nodes})=>{
    await recorder.prepare();const errors:Error[]=[];const clips:Blob[]=[];
    recorder.start(blob=>clips.push(blob),()=>{},e=>errors.push(e));
    const feed=(seconds:number,level=0)=>{for(let n=0;n<seconds*10;n++)nodes[0].port.onmessage({data:new Float32Array(1600).fill(level)});};
    feed(90);assert.deepEqual(errors,[]);assert.equal(clips.length,0);
    assert.ok((recorder as any).count<=4800,'initial buffered audio must stay within 300ms');
    feed(.3,.1);feed(2);assert.equal(clips.length,0);feed(.3,.1);feed(2.6);
    assert.deepEqual(errors,[]);assert.equal(clips.length,1);
    const data=new DataView(await clips[0].arrayBuffer());assert.ok(data.getUint32(40,true)/32000<6,'long initial silence must not crowd out speech');
    assert.ok(data.getUint32(40,true)/32000>4.8,'both sides of a two-second pause must be retained');
  },'none');
});
test('recorder emits a bounded WAV at 24 seconds after speech begins',async()=>{
  await withFailingWorklet(async({recorder,nodes})=>{
    await recorder.prepare();const clips:Blob[]=[];const errors:Error[]=[];recorder.start(blob=>clips.push(blob),()=>{},e=>errors.push(e));
    for(let n=0;n<300;n++)nodes[0].port.onmessage({data:new Float32Array(1600)});
    for(let n=0;n<240;n++)nodes[0].port.onmessage({data:new Float32Array(1600).fill(.08)});
    assert.deepEqual(errors,[]);assert.equal(clips.length,1);assert.ok(clips[0].size<=768044);
  },'none');
});
test('failed worklet setup immediately releases the acquired microphone and audio context',async()=>{
  await withFailingWorklet(async({recorder,tracks,contexts})=>{
    await assert.rejects(recorder.prepare(),/worklet load failed/);
    assert.equal(tracks[0].readyState,'ended');assert.equal(contexts[0].state,'closed');
  });
});

test('mobile recorder can initialize with the prefixed Web Audio constructor',async()=>{
  await withFailingWorklet(async({recorder})=>{
    (window as any).webkitAudioContext=globalThis.AudioContext;
    Reflect.deleteProperty(globalThis,'AudioContext');
    await recorder.prepare();
    const errors:Error[]=[];recorder.start(()=>{},()=>{},e=>errors.push(e));assert.deepEqual(errors,[]);
  },'none');
});
test('prepare after a worklet failure builds a complete recording graph and captures the next answer',async()=>{
  await withFailingWorklet(async({recorder,nodes})=>{
    await assert.rejects(recorder.prepare(),/worklet load failed/);await recorder.prepare();
    let wav:Blob|undefined;const errors:Error[]=[];recorder.start(blob=>{wav=blob;},()=>{},e=>errors.push(e));
    assert.equal(nodes.length,1,'retry must create the missing worklet node');
    nodes[0].port.onmessage({data:new Float32Array(3200).fill(.1)});recorder.finish();
    assert.equal(wav?.type,'audio/wav');assert.deepEqual(errors,[]);
  });
});
for(const stage of ['source','node','gain','connect'])test('failed '+stage+' setup is released and the next recording setup succeeds',async()=>{
  await withFailingWorklet(async({recorder,tracks,contexts,nodes})=>{
    await assert.rejects(recorder.prepare(),new RegExp(stage+' failed'));
    assert.equal(tracks[0].readyState,'ended');assert.equal(contexts[0].state,'closed');
    await recorder.prepare();await recorder.prepare();assert.equal(contexts.length,2,'only the complete graph may be reused');
    let wav:Blob|undefined;const errors:Error[]=[];recorder.start(blob=>{wav=blob;},()=>{},e=>errors.push(e));
    nodes.at(-1).port.onmessage({data:new Float32Array(3200).fill(.1)});recorder.finish();assert.equal(wav?.type,'audio/wav');assert.deepEqual(errors,[]);
  },stage);
});
test('a late resume failure from a released context cannot release the replacement recording graph',async()=>{
  await withFailingWorklet(async({recorder,contexts,tracks,nodes})=>{
    await recorder.prepare();let rejectOld!:(error:Error)=>void;
    contexts[0].resume=()=>new Promise<void>((_,reject)=>{rejectOld=reject;});
    const old=assert.rejects(recorder.prepare(),/old resume failed/);recorder.release();await recorder.prepare();rejectOld(new Error('old resume failed'));await old;
    assert.equal(tracks[1].readyState,'live');let wav:Blob|undefined;const errors:Error[]=[];
    recorder.start(blob=>{wav=blob;},()=>{},e=>errors.push(e));nodes.at(-1).port.onmessage({data:new Float32Array(3200).fill(.1)});recorder.finish();
    assert.equal(wav?.type,'audio/wav');assert.deepEqual(errors,[]);
  },'none');
});
