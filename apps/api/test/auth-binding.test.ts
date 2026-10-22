import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, identity, testConfig } from './http-fixture.js';
import { patient } from './fixture.js';
import { hashPassword } from '../src/modules/auth.js';
import { validateConfig } from '../src/config.js';

test('auth: clinician login authenticates password, cookie, csrf and revoked logout', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician');
  await db.query('UPDATE accounts SET login_name=$1,password_hash=$2 WHERE id=$3', ['doctor', await hashPassword('CorrectPassword123!'), doctor.id]);
  const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/clinician/login', payload: { username: 'doctor', password: 'bad' } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/clinician/login', payload: { username: 'doctor', password: 'CorrectPassword123!' } });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  const csrf = ok.json().csrfToken;
  assert.match(String(ok.headers['set-cookie']), /HttpOnly/i);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie } })).statusCode, 401);
});

test('auth: production rejects local identity and scripted providers', () => {
  assert.throws(() => validateConfig({ ...testConfig, nodeEnv: 'production' }), /production/i);
});

test('binding: claiming code does not expose record before clinician verification', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const user = await identity(db, 'patient');
  const p = await patient(db, doctor.id, '私密姓名');
  const invitation = await app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p}/invitations`, headers: doctor.headers });
  assert.equal(invitation.statusCode, 201);
  const code = invitation.json().code;
  assert.equal(code.length, 12);
  const claim = await app.inject({ method: 'POST', url: '/api/v1/patient/binding', headers: user.headers, payload: { code, name: '申请人', birthDate: '1980-01-01', phone: '13800000000' } });
  assert.equal(claim.statusCode, 201);
  const workspace = await app.inject({ url: '/api/v1/patient/me', headers: user.headers });
  assert.equal(workspace.statusCode, 200); assert.equal(workspace.json().patient, null); assert.ok(!workspace.body.includes('私密姓名'));
  const requestId = claim.json().id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/clinician/bindings/${requestId}/review`, headers: doctor.headers, payload: { approved: true, verificationMethod: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/clinician/bindings/${requestId}/review`, headers: doctor.headers, payload: { approved: true, verificationMethod: '已通过建档电话核对' } })).statusCode, 200);
  assert.equal((await db.query('SELECT account_id FROM patient_records WHERE id=$1', [p])).rows[0].account_id, user.id);
  assert.notEqual((await db.query('SELECT code_hash FROM patient_invitations WHERE patient_id=$1', [p])).rows[0].code_hash, code);
});

test('binding: concurrent claims are single-use and cannot be approved by another doctor', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const other = await identity(db, 'clinician');
  const a = await identity(db, 'patient'); const b = await identity(db, 'patient');
  const p = await patient(db, doctor.id);
  const inv = (await app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p}/invitations`, headers: doctor.headers })).json();
  const results = await Promise.all([a,b].map(user => app.inject({ method: 'POST', url: '/api/v1/patient/binding', headers: user.headers, payload: { code: inv.code, name: '测试', birthDate: '1980-01-01', phone: '13800000000' } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201,400]);
  const id = results.find(r => r.statusCode === 201)!.json().id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/clinician/bindings/${id}/review`, headers: other.headers, payload: { approved: true, verificationMethod: '电话确认' } })).statusCode, 404);
  assert.equal((await db.query('SELECT count(*)::int n FROM binding_requests')).rows[0].n, 1);
});

test('binding: expired invitations and patient access to clinician routes are refused', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const user = await identity(db, 'patient'); const p = await patient(db, doctor.id);
  const inv = (await app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p}/invitations`, headers: doctor.headers })).json();
  await db.query("UPDATE patient_invitations SET expires_at=now()-interval '1 second'");
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/patient/binding', headers: user.headers, payload: { code: inv.code, name: '测试', birthDate: '1980-01-01', phone: '13800000000' } })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/v1/clinician/patients', headers: user.headers })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/v1/clinician/patients/${randomUUID()}`, headers: user.headers })).statusCode, 403);
});
