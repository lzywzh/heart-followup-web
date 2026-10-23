import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../src/voice/controller.js';

const session = (version = 1, turns: any[] = []) => ({ id: 'session', version, status: 'active', greeting: '您好，请说说今天的情况。', turns });
const answer = session(2, [{ status: 'completed', patientText: '今天很好', assistantText: '今天的体重是多少？', clientMessageId: 'utterance' }]);
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const events: string[] = []; let onSegment: ((blob: Blob) => void) | undefined;
  const playback = deferred(); const upload = deferred<any>();
  const boundaries = {
    recorder: { prepare: async () => { events.push('permission'); }, start: (segment: (blob: Blob) => void) => { events.push('listen'); onSegment = segment; }, finish: () => {}, cancel: () => { events.push('mic-stop'); }, release: () => { events.push('mic-release'); } },
    speaker: { prepare: async () => {}, speak: async () => { events.push('speak'); await playback.promise; }, cancel: () => { events.push('speech-stop'); } },
    api: { upload: async () => { events.push('upload'); return upload.promise; }, get: async () => answer, pause: async () => session(), resume: async () => session(), end: async (_id: string, version: number) => { events.push('end:'+version); return { ...answer, status: 'submitted', briefSummary: { title: '本次随访', items: [], note: '待医生审核' } }; } },
    changed: () => {}, uuid: () => 'utterance',
  };
  const controller = new VoiceController(boundaries);
  return { controller, events, playback, upload, boundaries, segment: () => onSegment!(new Blob(['wav'])) };
}

test('Agent closure leaves microphone open and patient-requested completion plays farewell then releases it',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start({...session(),status:'awaiting_confirmation'});assert.equal(h.controller.state,'listening');
  h.segment();await tick();const before=h.events.filter(e=>e==='speak').length;
  h.upload.resolve({session:{...answer,status:'submitted',turns:[{status:'completed',patientText:'没什么要补充了',assistantText:'好的，再见。'}]}});
  await tick();await tick();assert.equal(h.controller.state,'ended');assert.equal(h.controller.lastText,'好的，再见。');assert.equal(h.events.filter(e=>e==='speak').length,before+1);assert.equal(h.events.at(-1),'mic-release');assert.ok(!h.events.some(e=>e.startsWith('end:')));
});
test('assistant finishes speaking before microphone begins listening', async () => {
  const h = setup(); const start = h.controller.start(session()); await tick();
  assert.equal(h.controller.state, 'speaking'); assert.ok(!h.events.includes('listen'));
  h.playback.resolve(); await start; assert.equal(h.controller.state, 'listening');
});
test('pause fences late playback callbacks', async () => {
  const h = setup(); const start = h.controller.start(session()); await tick(); await h.controller.pause();
  h.playback.resolve(); await start; assert.equal(h.controller.state, 'paused'); assert.ok(!h.events.includes('listen'));
});
test('interrupt cancels speech before opening microphone', async () => {
  const h = setup(); const start = h.controller.start(session()); await tick(); await h.controller.interrupt();
  assert.equal(h.controller.state, 'listening'); assert.ok(h.events.indexOf('speech-stop') < h.events.indexOf('listen'));
  h.playback.resolve(); await start; assert.equal(h.events.filter(e => e === 'listen').length, 1);
});
test('hangup waits for upload and submits its updated version once', async () => {
  const h = setup(); h.playback.resolve(); await h.controller.start(session()); h.segment(); await tick();
  const end = h.controller.end(); const again = h.controller.end(); await tick();
  assert.equal(h.controller.state, 'ending'); assert.ok(!h.events.some(e => e.startsWith('end:')));
  h.upload.resolve({ session: answer, transcript: '今天很好' }); await Promise.all([end, again]);
  assert.deepEqual(h.events.filter(e => e.startsWith('end:')), ['end:2']); assert.equal(h.controller.state, 'ended');
});
test('upload failure prevents hangup from submitting an empty session', async () => {
  const h = setup(); h.playback.resolve(); await h.controller.start(session()); h.segment(); await tick();
  const end = h.controller.end(); h.upload.reject(new Error('网络已断开')); await end;
  assert.equal(h.controller.state, 'error'); assert.ok(!h.events.some(e => e.startsWith('end:')));
});
test('pause retains a completed upload without starting late assistant speech', async () => {
  const h = setup(); h.playback.resolve(); await h.controller.start(session()); h.segment(); await tick(); await h.controller.pause();
  h.upload.resolve({ session: answer }); await tick(); await tick();
  assert.equal(h.controller.state, 'paused'); assert.equal(h.controller.session.version, 2); assert.equal(h.events.filter(e=>e==='speak').length, 1);
});
test('empty call remains incomplete without invoking end API', async () => {
  const h = setup(); h.playback.resolve(); await h.controller.start(session()); await h.controller.end();
  assert.equal(h.controller.state, 'error'); assert.ok(!h.events.some(e=>e.startsWith('end:')));
});
test('permission rejection remains recoverable and never records',async()=>{
  const h=setup();h.boundaries.recorder.prepare=async()=>{throw new Error('permission denied');};
  await h.controller.start(session());assert.equal(h.controller.state,'error');assert.match(h.controller.error,/permission denied/);assert.ok(!h.events.includes('listen'));
});
test('a queued segment after pause never uploads',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start(session());await h.controller.pause();h.segment();await tick();
  assert.equal(h.controller.state,'paused');assert.ok(!h.events.includes('upload'));
});
test('retry after response loss recovers saved turn without sending another upload',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start(session());h.segment();await tick();h.upload.reject(new Error('response lost'));await tick();
  await h.controller.retry();assert.equal(h.controller.state,'listening');assert.equal(h.controller.session.version,2);assert.equal(h.events.filter(e=>e==='upload').length,1);
});
test('retry of unsaved audio preserves its bytes, key and expected version',async()=>{
  const h=setup();const sent:unknown[][]=[];let attempts=0;
  h.boundaries.api.get=async()=>session();
  h.boundaries.api.upload=async(...args:unknown[])=>{sent.push(args);if(++attempts===1)throw new Error('offline');return {session:answer};};
  h.playback.resolve();await h.controller.start(session());h.segment();await tick();await h.controller.retry();
  assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(h.controller.state,'listening');
});
test('pending operation after reload prevents recording until explicit retry',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start({...session(),audioOperations:[{clientMessageId:'pending',status:'processing'}]});
  assert.equal(h.controller.state,'error');assert.ok(!h.events.includes('listen'));
  h.boundaries.api.get=async()=>answer;await h.controller.retry();assert.equal(h.controller.state,'listening');
});
test('playback failure requires explicit retry before recording',async()=>{
  const h=setup();const start=h.controller.start(session());await tick();h.playback.reject(new Error('playback blocked'));await start;
  assert.equal(h.controller.state,'error');assert.ok(!h.events.includes('listen'));
});
test('disposed controller ignores late uploaded answer',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start(session());h.segment();await tick();h.controller.dispose();h.upload.resolve({session:answer});await tick();
  assert.equal(h.controller.session.version,1);assert.equal(h.events.filter(e=>e==='speak').length,1);
});
test('no-speech rejection allows a fresh answer instead of replaying rejected audio forever',async()=>{
  const h=setup();let attempts=0;h.boundaries.api.get=async()=>session();
  h.boundaries.api.upload=async()=>{attempts++;throw Object.assign(new Error('请重新说一次'),{code:'NO_SPEECH'});};
  h.playback.resolve();await h.controller.start(session());h.segment();await tick();await h.controller.retry();
  assert.equal(attempts,1);assert.equal(h.controller.state,'listening');
});
test('reopening a controller fences an upload from the previous screen lifetime',async()=>{
  const h=setup();h.playback.resolve();await h.controller.start(session());h.segment();await tick();h.controller.dispose();
  await h.controller.start({...session(5),id:'new-session'});h.upload.resolve({session:answer});await tick();
  assert.equal(h.controller.session.id,'new-session');assert.equal(h.controller.session.version,5);
});
