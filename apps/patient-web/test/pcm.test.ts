import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, SilenceSegmenter } from '../src/voice/pcm.js';
test('WAV resamples 48kHz to mono 16kHz PCM16 with a valid bounded RIFF header',()=>{
  const bytes=encodeWav(new Float32Array(48000).fill(.5),48000); const data=new DataView(bytes);
  assert.equal(bytes.byteLength,32044);assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');
  assert.equal(data.getUint32(24,true),16000);assert.equal(data.getUint16(22,true),1);assert.equal(data.getUint16(34,true),16);
  assert.equal(data.getInt16(44,true),16384);
});
test('silence segmenter ignores silence until voiced speech then ends after 850ms trailing silence',()=>{
  const detector=new SilenceSegmenter(16000);
  assert.equal(detector.push(new Float32Array(16000)).finish,false);
  assert.equal(detector.push(new Float32Array(4800).fill(.08)).voiced,true);
  assert.equal(detector.push(new Float32Array(11200)).finish,false);
  assert.equal(detector.push(new Float32Array(2400)).finish,true);
});
test('segmenter bounds one voiced recording to 24 seconds',()=>{
  const detector=new SilenceSegmenter(16000);const tone=new Float32Array(16000).fill(.06);
  for(let n=0;n<23;n++)assert.equal(detector.push(tone).finish,false);
  assert.equal(detector.push(tone).finish,true);
});
