import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, SilenceSegmenter } from '../src/voice/pcm.js';
test('WAV resamples 48kHz to mono 16kHz PCM16 with a valid bounded RIFF header',()=>{
  const bytes=encodeWav(new Float32Array(48000).fill(.5),48000); const data=new DataView(bytes);
  assert.equal(bytes.byteLength,32044);assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');
  assert.equal(data.getUint32(24,true),16000);assert.equal(data.getUint16(22,true),1);assert.equal(data.getUint16(34,true),16);
  assert.equal(data.getInt16(44,true),16384);
});
test('silence segmenter tolerates two-second pauses and resets the quiet timer when speech resumes',()=>{
  const detector=new SilenceSegmenter(16000);
  assert.equal(detector.push(new Float32Array(16000)).finish,false);
  assert.equal(detector.push(new Float32Array(4800).fill(.08)).voiced,true);
  assert.equal(detector.push(new Float32Array(32000)).finish,false);
  assert.equal(detector.push(new Float32Array(3200).fill(.08)).finish,false);
  assert.equal(detector.push(new Float32Array(38400)).finish,false);
  assert.equal(detector.push(new Float32Array(1600)).finish,true);
});

test('initial silence does not consume the 24-second speech window',()=>{
  const detector=new SilenceSegmenter(16000),quiet=new Float32Array(16000),tone=new Float32Array(16000).fill(.06);
  for(let n=0;n<180;n++)assert.equal(detector.push(quiet).finish,false);
  for(let n=0;n<23;n++)assert.equal(detector.push(tone).finish,false);
  assert.equal(detector.push(tone).finish,true);
});
test('24-second speech window includes intermittent pauses',()=>{
  const detector=new SilenceSegmenter(16000);let result:any;
  for(let n=0;n<24;n++){result=detector.push(new Float32Array(16000).fill(n%2===0?.06:0));if(n<23)assert.equal(result.finish,false);}
  assert.equal(result.finish,true);
});
test('segmenter bounds one voiced recording to 24 seconds',()=>{
  const detector=new SilenceSegmenter(16000);const tone=new Float32Array(16000).fill(.06);
  for(let n=0;n<23;n++)assert.equal(detector.push(tone).finish,false);
  assert.equal(detector.push(tone).finish,true);
});
