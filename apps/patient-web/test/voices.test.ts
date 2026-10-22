import test from 'node:test';
import assert from 'node:assert/strict';
import {chineseVoice} from '../src/voice/voices.js';
test('selects an available natural simplified Chinese voice before legacy Chinese or English voices',()=>{
  const voices=[{lang:'en-US',name:'English Natural'},{lang:'zh-CN',name:'Microsoft Huihui'},{lang:'zh-CN',name:'Microsoft Xiaoxiao Online (Natural)'}] as SpeechSynthesisVoice[];
  assert.equal(chineseVoice(voices)?.name,'Microsoft Xiaoxiao Online (Natural)');assert.equal(voices[0].name,'English Natural');
});
test('missing simplified Chinese voice remains unavailable instead of choosing an unrelated language',()=>{
  assert.equal(chineseVoice([{lang:'en-US',name:'English'},{lang:'zh-HK',name:'Cantonese'}] as SpeechSynthesisVoice[]),undefined);
});
