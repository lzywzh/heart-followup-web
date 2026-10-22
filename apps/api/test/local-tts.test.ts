import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTts} from '../src/voice/local-tts.js';

test('local TTS unavailable, busy and malformed audio fail without returning fabricated speech',async()=>{
  assert.equal((await createLocalTts('').status()).available,false);
  await assert.rejects(createLocalTts('').synthesize('您好'),/尚未连接/);
  const busy=createLocalTts('http://127.0.0.1:3020',async()=>new Response('{}',{status:429}));
  await assert.rejects(busy.synthesize('您好'),(e:any)=>e.code==='TTS_BUSY');
  const broken=createLocalTts('http://127.0.0.1:3020',async()=>new Response('not an audio file'));
  await assert.rejects(broken.synthesize('您好'),/语音格式/);
  const oversized=createLocalTts('http://127.0.0.1:3020',async()=>new Response('bad',{headers:{'content-length':'5000000'}}));
  await assert.rejects(oversized.synthesize('您好'),/没有完整生成/);
});

test('local TTS health requires ready=true and synthesis sends only the bounded requested sentence',async()=>{
  const requests:string[]=[];
  const tts=createLocalTts('http://127.0.0.1:3020',async(url,options)=>{
    requests.push(String(url));
    if(String(url).endsWith('/health'))return new Response('{"ready":false}');
    assert.deepEqual(JSON.parse(String(options?.body)),{text:'您好'});
    return new Response('{}',{status:503});
  });
  assert.equal((await tts.status()).available,false);
  await assert.rejects(tts.synthesize('您好'),/暂不可用/);
  await assert.rejects(tts.synthesize('字'.repeat(501)),/内容过长/);
  assert.equal(requests.length,2);
});
