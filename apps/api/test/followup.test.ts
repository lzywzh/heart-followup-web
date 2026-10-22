import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, identity, boundPatient } from './http-fixture.js';
import { processNextJob } from '../src/jobs/worker.js';

async function started(t: any, override: any = {}, providers: any = {}) {
  const f = await httpFixture(t, override, providers); const d = await identity(f.db, 'clinician'); const p = await boundPatient(f.db, d.id);
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/patient/followups', headers: p.user.headers, payload: { clientRequestId: randomUUID() } });
  assert.equal(response.statusCode, 201, response.body);
  return { ...f, d, p, session: response.json() };
}
const say = (f: any, text: string, key = randomUUID(), version = f.session.version) => f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/messages`, headers: f.p.user.headers, payload: { clientMessageId: key, expectedVersion: version, text } });
function deferred<T=any>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}

test('production: missing protocol approval explains how to unblock followup and creates no session', async t => {
  const f = await httpFixture(t, { nodeEnv: 'production', authMode: 'wechat', collectionMode: 'ai' });
  const doctor = await identity(f.db, 'clinician');
  const patient = await boundPatient(f.db, doctor.id);
  const request = { method: 'POST' as const, url: '/api/v1/patient/followups', headers: patient.user.headers, payload: { clientRequestId: randomUUID() } };
  const blocked = await f.app.inject(request);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'PROTOCOL_NOT_APPROVED');
  assert.match(blocked.json().error.message, /模板|协议/);
  assert.match(blocked.json().error.message, /确认|审核/);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM followup_sessions')).rows[0].n, 0);

  const approval = await f.app.inject({ method: 'POST', url: '/api/v1/clinician/protocol/approve', headers: doctor.headers, payload: { note: '隔离测试：采集问题、结束条件和求助提示已经核对' } });
  assert.equal(approval.statusCode, 200, approval.body);
  const opened = await f.app.inject(request);
  assert.equal(opened.statusCode, 201, opened.body);
  assert.equal((await f.db.query('SELECT protocol_approved FROM followup_sessions')).rows[0].protocol_approved, true);
});

test('errors: database uniqueness conflicts do not expose internal constraint details', async t => {
  const f = await httpFixture(t);
  const doctor = await identity(f.db, 'clinician');
  f.app.get('/test/database-conflict', async () => {
    await f.db.query("INSERT INTO accounts(id,role,display_name) VALUES($1,'clinician','private-database-detail')", [doctor.id]);
    return { ok: true };
  });
  const response = await f.app.inject({ url: '/test/database-conflict' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'CONFLICT');
  assert.doesNotMatch(response.body, /accounts_pkey|duplicate key|private-database-detail/);
});

test('followup: reclaimed turn fences out the earlier execution even for the same version',async t=>{
  const entered=deferred<void>();const old=deferred();let calls=0;
  const f=await started(t,{}, {dialogue:{nextTurn:async()=>{if(++calls===1){entered.resolve();return old.promise;}return {facts:[{field:'breathing',evidence:'最近呼吸还好',status:'reported'}]};}}});
  const key=randomUUID();const first=Promise.resolve(say(f,'最近呼吸还好',key));await entered.promise;
  await f.db.query("UPDATE followup_turns SET lease_until=now()-interval '1 second' WHERE session_id=$1",[f.session.id]);
  const fresh=await say(f,'最近呼吸还好',key);assert.equal(fresh.statusCode,200);old.resolve({facts:[]});const stale=await first;
  assert.equal(stale.statusCode,409);const current=(await f.app.inject({url:`/api/v1/patient/followups/${f.session.id}`,headers:f.p.user.headers})).json();
  assert.equal(current.summary.items[0].value,'最近呼吸还好');assert.equal((await f.db.query("SELECT count(*)::int n FROM agent_runs WHERE role='dialogue'")).rows[0].n,1);
});

for(const late of ['success','failure'])test(`jobs: reclaimed worker is not overwritten by old ${late}`,async t=>{
  const f=await started(t);await say(f,'最近呼吸还好');const entered=deferred<void>();const old=deferred();let calls=0;
  const provider={review:{review:async()=>{if(++calls===1){entered.resolve();return old.promise;}return [{role:'judge',provider:'test',model:'none',output:{mark:'fresh'}}];}}};
  const config=(await import('./http-fixture.js')).testConfig;const first=processNextJob({db:f.db,config,providers:provider});await entered.promise;
  await f.db.query("UPDATE background_jobs SET lease_until=now()-interval '1 second' WHERE session_id=$1",[f.session.id]);await processNextJob({db:f.db,config,providers:provider});
  if(late==='success')old.resolve([{role:'judge',provider:'test',model:'none',output:{mark:'stale'}}]);else old.reject(new Error('old failure'));
  await first;const current=(await f.db.query('SELECT ai_review FROM followup_sessions WHERE id=$1',[f.session.id])).rows[0];
  assert.equal(current.ai_review.runs[0].output.mark,'fresh');assert.equal((await f.db.query('SELECT status FROM background_jobs')).rows[0].status,'completed');
  assert.equal((await f.db.query("SELECT count(*)::int n FROM agent_runs WHERE role='judge'")).rows[0].n,1);
});

test('followup: expired pending after restart can be submitted as unconfirmed without losing original text',async t=>{
  const f=await started(t);await f.db.query("INSERT INTO followup_turns(id,session_id,client_message_id,sequence,patient_text,session_version,lease_until) VALUES($1,$2,$3,1,'重启前保存但未完成的回答',2,now()-interval '1 second')",[randomUUID(),f.session.id,randomUUID()]);
  await f.db.query('UPDATE followup_sessions SET version=2 WHERE id=$1',[f.session.id]);
  const result=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.session.id}/submit`,headers:f.p.user.headers,payload:{expectedVersion:2,confirmed:false}});
  assert.equal(result.statusCode,200,result.body);assert.equal(result.json().patientConfirmed,false);assert.equal(result.json().turns[0].status,'failed');assert.equal(result.json().turns[0].patientText,'重启前保存但未完成的回答');
});

test('followup: retries return one active session and a repeated turn never duplicates data', async t => {
  const f = await started(t); const repeated = await f.app.inject({ method: 'POST', url: '/api/v1/patient/followups', headers: f.p.user.headers, payload: { clientRequestId: randomUUID() } });
  assert.equal(repeated.json().id, f.session.id);
  const key = randomUUID(); const first = await say(f, '最近上楼有些喘', key);
  assert.equal(first.statusCode, 200, first.body);
  const again = await say(f, '最近上楼有些喘', key);
  assert.equal(again.statusCode, 200); assert.equal(again.json().turns.length, 1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM followup_turns')).rows[0].n, 1);
  assert.equal((await say(f, '完全不同的内容', key)).statusCode, 409);
});

test('followup: future and cancelled tasks cannot be started or consumed by an unrelated patient', async t => {
  const f = await httpFixture(t); const d = await identity(f.db, 'clinician'); const p = await boundPatient(f.db, d.id); const another = await boundPatient(f.db, d.id);
  const task = (await f.app.inject({ method: 'POST', url: '/api/v1/clinician/tasks', headers: d.headers, payload: { patientId: p.patientId, scheduledAt: new Date(Date.now()+72*3600000).toISOString() } })).json();
  for (const user of [p.user, another.user]) {
    const r = await f.app.inject({ method: 'POST', url: '/api/v1/patient/followups', headers: user.headers, payload: { clientRequestId: randomUUID(), taskId: task.id } });
    assert.ok([404,409].includes(r.statusCode));
  }
  await f.db.query("UPDATE followup_tasks SET status='cancelled' WHERE id=$1", [task.id]);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/patient/followups', headers: p.user.headers, payload: { clientRequestId: randomUUID(), taskId: task.id } })).statusCode, 409);
});

test('followup: old versions and other patients cannot append, read or submit a session', async t => {
  const f = await started(t); const other = await boundPatient(f.db, f.d.id);
  assert.equal((await say(f, '最近情况还好', randomUUID(), 999)).statusCode, 409);
  assert.equal((await f.app.inject({ url: `/api/v1/patient/followups/${f.session.id}`, headers: other.user.headers })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/submit`, headers: other.user.headers, payload: { expectedVersion: 1, confirmed: true } })).statusCode, 404);
});

test('followup: correction preserves original answer and replaces its evidence in the summary', async t => {
  const f = await started(t); const a = await say(f, '最近上楼有些喘');
  const original = a.json().turns[0];
  const c = await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/corrections`, headers: f.p.user.headers, payload: { turnId: original.id, text: '更正：最近活动没有气喘', expectedVersion: a.json().version, clientMessageId: randomUUID() } });
  assert.equal(c.statusCode, 200, c.body); assert.equal(c.json().turns.length, 2);
  assert.equal(c.json().turns[0].patientText, '最近上楼有些喘');
  assert.equal(c.json().turns[0].superseded, true);
  assert.ok(JSON.stringify(c.json().summary).includes('最近活动没有气喘'));
  assert.ok(!JSON.stringify(c.json().summary).includes('最近上楼有些喘'));
});

test('followup: pause persists, refuses new turns, and resumes at the saved version', async t => {
  const f = await started(t);
  const pause = await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/pause`, headers: f.p.user.headers });
  assert.equal(pause.statusCode, 200); assert.equal(pause.json().status, 'paused');
  assert.equal((await say(f, '不应提交的录音')).statusCode, 409);
  const resumed = await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/resume`, headers: f.p.user.headers });
  assert.equal(resumed.json().status, 'active'); assert.equal(resumed.json().version, f.session.version);
});

test('followup: final confirmation freezes transcript and unpublished doctor feedback stays private', async t => {
  const f = await started(t); const a = await say(f, '最近活动没有气喘');
  const finish = await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/submit`, headers: f.p.user.headers, payload: { expectedVersion: a.json().version, confirmed: false } });
  assert.equal(finish.statusCode, 200, finish.body); assert.equal(finish.json().patientConfirmed, false);
  assert.equal((await say(f, '已提交后不能追加', randomUUID(), a.json().version)).statusCode, 409);
  const reviewBody = { expectedVersion: a.json().version, feedback: '请按既定计划复诊', published: false, summary: { note: '医生核对记录' } };
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/followups/${f.session.id}/review`, headers: f.d.headers, payload: reviewBody })).statusCode, 200);
  const pending = await f.app.inject({ url: `/api/v1/patient/followups/${f.session.id}`, headers: f.p.user.headers });
  assert.ok(!pending.body.includes('请按既定计划复诊')); assert.ok(!pending.body.includes('医生核对记录')); assert.ok(!pending.body.includes('agentRuns'));
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/followups/${f.session.id}/review`, headers: f.d.headers, payload: { ...reviewBody, published: true } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: `/api/v1/patient/followups/${f.session.id}`, headers: f.p.user.headers })).json().feedback, '请按既定计划复诊');
});

test('followup: missing AI cannot fabricate replies and severe symptoms stop routine collection', async t => {
  const f = await started(t, { collectionMode: 'ai' });
  const r = await say(f, '最近说不清具体情况');
  assert.equal(r.statusCode, 200); assert.equal(r.json().requiresHumanReview, true);
  assert.match(r.json().turns[0].assistantText, /医护|医生|人工/);
  const emergency = await started(t);
  const e = await say(emergency, '现在喘得说不出完整的话');
  assert.equal(e.statusCode, 200); assert.equal(e.json().requiresHumanReview, true); assert.equal(e.json().status, 'handoff');
  assert.ok(!e.body.includes('医生已收到'));
});

test('followup: refusal/unknown is not normal and collection does not loop beyond ten answers', async t => {
  const f = await started(t);
  let s = f.session;
  for (let n=0; n<10; n++) {
    const r = await say(f, '我不清楚', randomUUID(), s.version); assert.equal(r.statusCode, 200, r.body); s = r.json();
    if (s.status === 'awaiting_confirmation') break;
  }
  assert.equal(s.status, 'awaiting_confirmation'); assert.equal(s.summary.complete, false);
  assert.ok(s.summary.items.some((i: any) => i.status === 'unknown'));
});

test('jobs: expired worker lease is reclaimed and stale analysis cannot overwrite corrected facts', async t => {
  const f = await started(t); const a = await say(f, '最近活动没有气喘');
  const firstJob = (await f.db.query('SELECT * FROM background_jobs ORDER BY created_at LIMIT 1')).rows[0];
  assert.ok(firstJob);
  await f.db.query("UPDATE background_jobs SET status='running',lease_until=now()-interval '1 second' WHERE id=$1", [firstJob.id]);
  const correction = await f.app.inject({ method: 'POST', url: `/api/v1/patient/followups/${f.session.id}/corrections`, headers: f.p.user.headers, payload: { turnId: a.json().turns[0].id, text: '更正：最近活动有些喘', expectedVersion: a.json().version, clientMessageId: randomUUID() } });
  assert.equal(correction.statusCode, 200);
  await processNextJob({ db: f.db, config: (await import('./http-fixture.js')).testConfig, providers: {} });
  assert.equal((await f.db.query('SELECT status FROM background_jobs WHERE id=$1', [firstJob.id])).rows[0].status, 'stale');
  assert.equal((await f.db.query('SELECT ai_review FROM followup_sessions WHERE id=$1', [f.session.id])).rows[0].ai_review, null);
});
