import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, identity, boundPatient } from './http-fixture.js';

function wav(seed = 1) {
  const frames = 6400; const result = Buffer.alloc(44 + frames * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(frames * 2, 40);
  for (let n = 0; n < frames; n++) result.writeInt16LE(Math.round(Math.sin(n * .1 + seed) * 4000), 44 + n * 2);
  return result;
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function enteredWithin(promise:Promise<void>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Voice route did not reach provider within 5 seconds')),5000);})]);}
  finally{clearTimeout(timer);}
}
async function begin(f: Awaited<ReturnType<typeof httpFixture>>, user: any, taskId?: string) {
  const response = await f.app.inject({ method:'POST', url:'/api/v1/patient/followups', headers:user.headers, payload:{ clientRequestId:randomUUID(), ...(taskId ? {taskId} : {}) } });
  assert.equal(response.statusCode, 201, response.body); return response.json();
}
function uploadUrl(id: string, version: number, messageId: string) {
  return `/api/v1/patient/followups/${id}/audio?expectedVersion=${version}&clientMessageId=${messageId}`;
}

test('browser voice: capabilities check local ASR and distinguish device speech from cloud', async t => {
  const f = await httpFixture(t, { voiceTtsMode:'browser' }, { localAsr:{ status:async()=>({available:false}) } });
  const user = await identity(f.db,'patient');
  const response = await f.app.inject({ url:'/api/v1/patient/voice/capabilities', headers:user.headers });
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().asr,false); assert.equal(response.json().ready,false);
  assert.equal(response.json().ttsMode,'browser'); assert.equal(response.json().tts,null);
  assert.equal(response.json().ttsStatus,'device-check-required');
  const doctor=await identity(f.db,'clinician');
  const doctorCaps=await f.app.inject({url:'/api/v1/clinician/voice/capabilities',headers:doctor.headers});
  assert.equal(doctorCaps.statusCode,200,doctorCaps.body);assert.equal(doctorCaps.json().ttsMode,'browser');
});

test('browser voice: server speech readiness checks the actual local TTS service', async t => {
  const f = await httpFixture(t, {voiceTtsMode:'server'} as any, {
    localAsr:{status:async()=>({available:true})}, localTts:{status:async()=>({available:false})},
  });
  const user=await identity(f.db,'patient');
  const response=await f.app.inject({url:'/api/v1/patient/voice/capabilities',headers:user.headers});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().ttsMode,'server');
  assert.equal(response.json().tts,false);
  assert.equal(response.json().ready,false);
  assert.equal(response.json().ttsStatus,'unavailable');
});

test('browser voice: local server WAV is owned, versioned and cached only after success', async t => {
  let calls=0;
  const f=await httpFixture(t,{voiceTtsMode:'server'} as any,{
    localAsr:{status:async()=>({available:true})},
    localTts:{status:async()=>({available:true}),synthesize:async(text:string)=>{calls++;assert.ok(text.includes('随访'));return wav();}},
  });
  const p=await boundPatient(f.db),s=await begin(f,p.user);
  const request={method:'POST' as const,url:`/api/v1/patient/followups/${s.id}/browser-speech`,headers:p.user.headers,payload:{expectedVersion:s.version}};
  const first=await f.app.inject(request);
  assert.equal(first.statusCode,200,first.body);
  assert.match(first.headers['content-type']||'',/audio\/wav/);
  assert.equal(first.rawPayload.toString('ascii',0,4),'RIFF');
  const second=await f.app.inject(request);assert.equal(second.statusCode,200,second.body);assert.equal(calls,1);
  const stranger=await boundPatient(f.db);
  assert.equal((await f.app.inject({...request,headers:stranger.user.headers})).statusCode,404);
  assert.equal((await f.app.inject({...request,payload:{expectedVersion:s.version+1}})).statusCode,409);
  assert.equal(calls,1);
});

test('browser voice: failed server speech is retryable and revoked patient cannot receive late synthesis',async t=>{
  let calls=0;const entered=latch(),release=latch();
  const f=await httpFixture(t,{voiceTtsMode:'server'}, {
    localAsr:{status:async()=>({available:true})},localTts:{status:async()=>({available:true}),synthesize:async()=>{
      calls++;if(calls===1)throw new Error('synthetic provider failure');entered.resolve();await release.promise;return wav();
    }},
  });
  const p=await boundPatient(f.db),s=await begin(f,p.user);
  const request={method:'POST' as const,url:`/api/v1/patient/followups/${s.id}/browser-speech`,headers:p.user.headers,payload:{expectedVersion:s.version}};
  assert.equal((await f.app.inject(request)).statusCode,500);
  const pending=f.app.inject(request);t.after(()=>release.resolve());await enteredWithin(entered.promise);
  await f.db.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1',[p.user.id]);release.resolve();
  const response=await pending;assert.equal(response.statusCode,401,response.body);assert.equal(calls,2);
});

test('browser voice: identical upload retries reuse one transcript and changed audio conflicts', async t => {
  let calls = 0;
  const f = await httpFixture(t, { voiceTtsMode:'browser' }, { localAsr:{status:async()=>({available:true}),transcribe:async()=>{calls++;return '最近走路呼吸还好，没有气短';}} });
  const p = await boundPatient(f.db); const s = await begin(f,p.user); const key=randomUUID();
  const request = { method:'POST' as const,url:uploadUrl(s.id,s.version,key),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav() };
  const first = await f.app.inject(request); assert.equal(first.statusCode,200,first.body);
  const retry = await f.app.inject(request); assert.equal(retry.statusCode,200,retry.body);
  assert.equal(calls,1); assert.equal(retry.json().session.version,first.json().session.version);
  assert.equal(retry.json().session.turns.length,1); assert.equal(retry.json().session.turns[0].source,'voice');
  assert.equal(retry.json().session.audioOperations[0].status,'completed');
  const changed = await f.app.inject({...request,payload:wav(2)}); assert.equal(changed.statusCode,409);
  assert.equal(calls,1);
  const stranger = await boundPatient(f.db);
  const stolen = await f.app.inject({...request,headers:{...stranger.user.headers,'content-type':'audio/wav'}});
  assert.equal(stolen.statusCode,404); assert.equal(calls,1);
});

test('browser voice: hangup waits for ASR and publishes the same concise summary to both portals', async t => {
  const entered=latch(), release=latch();
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=>{entered.resolve();await release.promise;return '最近走路呼吸还好';}}});
  const doctor=await identity(f.db,'clinician'); const p=await boundPatient(f.db,doctor.id); const s=await begin(f,p.user);
  const work=f.app.inject({method:'POST',url:uploadUrl(s.id,s.version,randomUUID()),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()});
  t.after(()=>release.resolve()); await enteredWithin(entered.promise);
  const pending=await f.app.inject({url:`/api/v1/patient/followups/${s.id}`,headers:p.user.headers});
  assert.equal(pending.json().audioOperations[0].status,'processing');
  const early=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${s.id}/end-call`,headers:p.user.headers,payload:{expectedVersion:s.version}});
  assert.equal(early.statusCode,409); assert.equal(early.json().error.code,'VOICE_PROCESSING');
  release.resolve(); const done=await work; assert.equal(done.statusCode,200,done.body);
  const end=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${s.id}/end-call`,headers:p.user.headers,payload:{expectedVersion:done.json().session.version}});
  assert.equal(end.statusCode,200,end.body); assert.equal(end.json().status,'submitted'); assert.equal(end.json().patientConfirmed,false);
  const summary=end.json().briefSummary; assert.ok(summary.items.some((v:any)=>v.value.includes('呼吸还好')));
  assert.ok(summary.items.some((v:any)=>v.value==='本次未采集'));
  const review=await f.app.inject({url:`/api/v1/clinician/followups/${s.id}`,headers:doctor.headers});
  assert.equal(review.statusCode,200,review.body); assert.deepEqual(review.json().briefSummary,summary);
  const me=await f.app.inject({url:'/api/v1/patient/me',headers:p.user.headers});
  assert.deepEqual(me.json().history[0].briefSummary,summary);
  await f.db.query("UPDATE followup_sessions SET ai_review=$1,clinician_summary=$2,feedback='仅供医生内部查看',feedback_published=false WHERE id=$3",[{note:'后台评估'},{note:'医生评估'},s.id]);
  const stable=await f.app.inject({url:`/api/v1/patient/followups/${s.id}`,headers:p.user.headers});
  assert.deepEqual(stable.json().briefSummary,summary); assert.equal(stable.json().feedback,null);
  const duplicate=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${s.id}/end-call`,headers:p.user.headers,payload:{expectedVersion:done.json().session.version}});
  assert.equal(duplicate.statusCode,200); assert.deepEqual(duplicate.json().briefSummary,summary);
});

test('browser voice: no speech and direct empty submission cannot consume a planned followup', async t => {
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=>''}});
  const doctor=await identity(f.db,'clinician'); const p=await boundPatient(f.db,doctor.id);
  const task=await f.app.inject({method:'POST',url:'/api/v1/clinician/tasks',headers:doctor.headers,payload:{patientId:p.patientId,scheduledAt:new Date().toISOString()}});
  assert.equal(task.statusCode,201,task.body); const s=await begin(f,p.user,task.json().id);
  const empty=await f.app.inject({method:'POST',url:uploadUrl(s.id,s.version,randomUUID()),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()});
  assert.equal(empty.statusCode,422,empty.body);
  for(const action of ['end-call','submit']) {
    const result=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${s.id}/${action}`,headers:p.user.headers,payload:{expectedVersion:s.version,...(action==='submit'?{confirmed:false}:{})}});
    assert.equal(result.statusCode,409,result.body); assert.equal(result.json().error.code,'EMPTY_CALL');
  }
  const row=(await f.db.query('SELECT status FROM followup_tasks WHERE id=$1',[task.json().id])).rows[0];
  assert.equal(row.status,'in_progress');
  assert.equal((await f.db.query('SELECT id FROM followup_turns WHERE session_id=$1',[s.id])).rowCount,0);
});

test('browser voice: revoked credentials cannot commit a late recognition result', async t => {
  const entered=latch(),release=latch();
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=>{entered.resolve();await release.promise;return '呼吸还好';}}});
  const p=await boundPatient(f.db);const s=await begin(f,p.user);
  const work=f.app.inject({method:'POST',url:uploadUrl(s.id,s.version,randomUUID()),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()});
  t.after(()=>release.resolve()); await enteredWithin(entered.promise); await f.db.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1',[p.user.id]);release.resolve();
  const response=await work;assert.equal(response.statusCode,401,response.body);
  assert.equal((await f.db.query("SELECT id FROM followup_turns WHERE session_id=$1 AND status='completed'",[s.id])).rowCount,0);
});

test('browser voice: revoked credentials cannot commit late model output', async t => {
  const entered=latch(),release=latch();
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=> '呼吸还好'},dialogue:{nextTurn:async()=>{entered.resolve();await release.promise;return {facts:[{field:'breathing',evidence:'呼吸还好',status:'reported'}],provider:'test',model:'test'};}}});
  const p=await boundPatient(f.db);const s=await begin(f,p.user);
  const work=f.app.inject({method:'POST',url:uploadUrl(s.id,s.version,randomUUID()),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()});
  t.after(()=>release.resolve()); await enteredWithin(entered.promise); await f.db.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1',[p.user.id]);release.resolve();
  const response=await work;assert.equal(response.statusCode,401,response.body);
  assert.equal((await f.db.query("SELECT id FROM followup_turns WHERE session_id=$1 AND status='completed'",[s.id])).rowCount,0);
});

test('browser voice: invalid WAV is rejected before recognition and overlapping retries stay single', async t => {
  const entered=latch(),release=latch();let calls=0;
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=>{calls++;entered.resolve();await release.promise;return '呼吸还好';}}});
  const p=await boundPatient(f.db),s=await begin(f,p.user);const key=randomUUID();
  const request={method:'POST' as const,url:uploadUrl(s.id,s.version,key),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()};
  const invalid=Buffer.from(wav());invalid.writeUInt32LE(48000,24);
  const malformed=await f.app.inject({...request,payload:invalid});
  assert.equal(malformed.statusCode,400);assert.equal(malformed.json().error.code,'INVALID_AUDIO');assert.equal(calls,0);
  const work=f.app.inject(request);t.after(()=>release.resolve());await enteredWithin(entered.promise);
  const overlap=await f.app.inject(request);assert.equal(overlap.statusCode,409);assert.equal(overlap.json().error.code,'VOICE_PROCESSING');
  release.resolve();assert.equal((await work).statusCode,200);assert.equal(calls,1);
});

test('browser voice: a reclaimed audio lease fences a late model worker and reuses saved ASR', async t => {
  const entered=latch(),release=latch();let asrCalls=0,modelCalls=0;
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=>{asrCalls++;return '呼吸还好';}},dialogue:{nextTurn:async()=>{
    modelCalls++;if(modelCalls===1){entered.resolve();await release.promise;}
    return {facts:[{field:'breathing',evidence:'呼吸还好',status:'reported'}],provider:'test',model:'test'};
  }}});
  const p=await boundPatient(f.db),s=await begin(f,p.user);const key=randomUUID();
  const request={method:'POST' as const,url:uploadUrl(s.id,s.version,key),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()};
  const old=f.app.inject(request);t.after(()=>release.resolve());await enteredWithin(entered.promise);
  await f.db.query("UPDATE browser_audio_requests SET lease_until=now()-interval '10 minutes' WHERE session_id=$1",[s.id]);
  await f.db.query("UPDATE followup_turns SET lease_until=now()-interval '10 minutes' WHERE session_id=$1",[s.id]);
  const replacement=await f.app.inject(request);assert.equal(replacement.statusCode,200,replacement.body);
  release.resolve();const late=await old;assert.equal(late.statusCode,409,late.body);
  assert.equal(asrCalls,1);assert.equal(modelCalls,2);
  const current=await f.app.inject({url:`/api/v1/patient/followups/${s.id}`,headers:p.user.headers});
  assert.equal(current.json().turns.length,1);assert.equal(current.json().turns[0].status,'completed');
  assert.equal(current.json().audioOperations[0].status,'completed');
});

test('browser voice: reload projects expired work as recoverable and accepts a fresh answer',async t=>{
  // Leave a clear expiry margin when the development database runs on another host.
  const f=await httpFixture(t,{voiceTtsMode:'browser'},{localAsr:{status:async()=>({available:true}),transcribe:async()=> '呼吸还好'}});
  const p=await boundPatient(f.db),s=await begin(f,p.user);const key=randomUUID();
  await f.db.query("INSERT INTO followup_turns(id,session_id,client_message_id,sequence,patient_text,source,session_version,status,lease_until) VALUES($1,$2,$3,1,'上一句未完成的语音','voice',2,'pending',now()-interval '10 minutes')",[randomUUID(),s.id,key]);
  await f.db.query('UPDATE followup_sessions SET version=2 WHERE id=$1',[s.id]);
  await f.db.query("INSERT INTO browser_audio_requests(id,session_id,account_id,client_message_id,expected_version,payload_hash,status,attempt_token,lease_until) VALUES($1,$2,$3,$4,1,'test-hash','processing',$5,now()-interval '10 minutes')",[randomUUID(),s.id,p.user.id,key,randomUUID()]);
  const restored=await f.app.inject({url:`/api/v1/patient/followups/${s.id}`,headers:p.user.headers});
  assert.equal(restored.json().turns[0].status,'failed');assert.equal(restored.json().audioOperations[0].status,'stale');
  const answered=await f.app.inject({method:'POST',url:uploadUrl(s.id,2,randomUUID()),headers:{...p.user.headers,'content-type':'audio/wav'},payload:wav()});
  assert.equal(answered.statusCode,200,answered.body);assert.equal(answered.json().session.turns[1].status,'completed');
});
