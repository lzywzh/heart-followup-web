import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/modules/auth.js';
import { assertActiveSession, digest } from '../src/modules/context.js';
import { httpFixture, identity, boundPatient } from './http-fixture.js';
import { patient } from './fixture.js';

const cookie = (response: any, name = 'hf_patient_session') => {
  const value = response.cookies.find((c: any) => c.name === name);
  assert.ok(value, `missing ${name}`);
  assert.equal(value.httpOnly, true);
  assert.equal(value.sameSite, 'Strict');
  return `${name}=${value.value}`;
};
const provision = async (f: any, doctor: any, id: string, username = 'Patient.One') => {
  const r = await f.app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${id}/web-account`, headers: doctor.headers, payload: { username } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(typeof r.json().temporaryPassword, 'string');
  return r.json();
};
const login = (f: any, username: string, password: string) => f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/login', payload: { username, password } });

// Catches patient login being absent, wrong-role credential acceptance, shared-cookie
// selection, missing CSRF/first-change gate, and password-change session reuse.
test('web auth: separate cookies survive patient logout and initial change rotates sessions', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician');
  await f.db.query('UPDATE accounts SET login_name=$1,password_hash=$2 WHERE id=$3', ['Doctor.One', await hashPassword('Doctor-pass-123'), doctor.id]);
  const id = await patient(f.db, doctor.id);
  const setup = await provision(f, doctor, id);
  assert.equal(setup.username, 'Patient.One');
  assert.equal((await login(f, 'Doctor.One', 'Doctor-pass-123')).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/clinician/login', payload: { username: setup.username, password: setup.temporaryPassword } })).statusCode, 401);
  const doctorLogin = await f.app.inject({ method: 'POST', url: '/api/v1/auth/clinician/login', payload: { username: 'Doctor.One', password: 'Doctor-pass-123' } });
  assert.equal(doctorLogin.statusCode, 200); const dc = cookie(doctorLogin, 'hf_session');
  const first = await login(f, setup.username, setup.temporaryPassword); assert.equal(first.statusCode, 200);
  assert.equal(first.json().account.mustChangePassword, true);
  const pc = cookie(first); const both = `${dc}; ${pc}`; const headers = { cookie: both, 'x-csrf-token': first.json().csrfToken };
  assert.equal((await f.app.inject({ url: '/api/v1/patient/auth/session', headers })).json().account.role, 'patient');
  assert.equal((await f.app.inject({ url: '/api/v1/auth/session', headers })).json().account.role, 'clinician');
  assert.equal((await f.app.inject({ url: '/api/v1/patient/me', headers })).json().error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/password', headers: { cookie: both }, payload: { currentPassword: setup.temporaryPassword, newPassword: 'Changed-pass-123' } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/password', headers, payload: { currentPassword: 'wrong', newPassword: 'Changed-pass-123' } })).statusCode, 401);
  const changed = await f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/password', headers, payload: { currentPassword: setup.temporaryPassword, newPassword: 'Changed-pass-123' } });
  assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().account.mustChangePassword, false);
  assert.equal((await f.app.inject({ url: '/api/v1/patient/auth/session', headers: { cookie: pc } })).statusCode, 401);
  assert.equal((await login(f, setup.username, setup.temporaryPassword)).statusCode, 401);
  const nextHeaders = { cookie: `${dc}; ${cookie(changed)}`, 'x-csrf-token': changed.json().csrfToken };
  assert.equal((await f.app.inject({ url: '/api/v1/patient/me', headers: nextHeaders })).json().patient.id, id);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: nextHeaders.cookie, 'x-csrf-token': doctorLogin.json().csrfToken } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/patient/auth/session', headers: nextHeaders })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/session', headers: { cookie: dc } })).statusCode, 401);
  const restoredDoctor = await f.app.inject({ method: 'POST', url: '/api/v1/auth/clinician/login', payload: { username: 'Doctor.One', password: 'Doctor-pass-123' } });
  nextHeaders.cookie = `${cookie(restoredDoctor, 'hf_session')}; ${cookie(changed)}`;
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/logout', headers: nextHeaders })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/session', headers: nextHeaders })).json().account.id, doctor.id);
  assert.equal((await f.app.inject({ url: '/api/v1/patient/auth/session', headers: { cookie: dc } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/session', headers: { cookie: cookie(changed) } })).statusCode, 401);
});

// Catches duplicate account creation, losing a bound identity, leaked status secrets,
// ignored ownership, and resetting credentials without revoking bearer/web sessions.
test('web accounts: reset preserves the bound identity and revokes every patient session only', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician'); const other = await identity(f.db, 'clinician');
  const p = await boundPatient(f.db, doctor.id);
  const setup = await provision(f, doctor, p.patientId);
  assert.equal(setup.accountId, p.user.id);
  const r = await login(f, setup.username, setup.temporaryPassword); const pc = cookie(r);
  const status = await f.app.inject({ url: `/api/v1/clinician/patients/${p.patientId}/web-account`, headers: doctor.headers });
  assert.equal(status.statusCode, 200); assert.equal(status.json().enabled, true);
  for (const secret of ['temporaryPassword', 'passwordHash', 'password_hash']) assert.equal(secret in status.json(), false);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p.patientId}/web-account`, headers: other.headers, payload: { username: 'stolen' } })).statusCode, 404);
  const reset = await provision(f, doctor, p.patientId);
  assert.notEqual(reset.temporaryPassword, setup.temporaryPassword);
  assert.equal((await login(f, setup.username, setup.temporaryPassword)).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/patient/auth/session', headers: { cookie: pc } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/session', headers: doctor.headers })).statusCode, 200);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM patient_records')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT account_id FROM patient_records WHERE id=$1', [p.patientId])).rows[0].account_id, p.user.id);
  assert.equal((await f.db.query("SELECT metadata::text AS metadata FROM audit_events WHERE action LIKE 'web_account.%'")).rows.some((a: any) => a.metadata.includes(reset.temporaryPassword)), false);
});

// Catches a read-then-create race and stale invitations attaching a second identity.
test('web accounts: concurrent provisioning binds once and expires outstanding binding state', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician'); const applicant = await identity(f.db, 'patient'); const id = await patient(f.db, doctor.id);
  const inv = randomUUID(); const request = randomUUID();
  await f.db.query("INSERT INTO patient_invitations(id,patient_id,clinician_id,code_hash,expires_at,claimed_by) VALUES($1,$2,$3,$4,now()+interval '1 day',$5)", [inv, id, doctor.id, digest('PENDING-CODE'), applicant.id]);
  await f.db.query('INSERT INTO binding_requests(id,invitation_id,patient_id,account_id,evidence) VALUES($1,$2,$3,$4,$5)', [request, inv, id, applicant.id, {}]);
  const [a, b] = await Promise.all([provision(f, doctor, id, 'Concurrent.A'), provision(f, doctor, id, 'Concurrent.B')]);
  assert.equal(a.accountId, b.accountId);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM accounts WHERE role='patient'")).rows[0].n, 2);
  assert.equal((await f.db.query('SELECT status FROM binding_requests WHERE id=$1', [request])).rows[0].status, 'expired');
  assert.ok((await f.db.query('SELECT revoked_at FROM patient_invitations WHERE id=$1', [inv])).rows[0].revoked_at);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/bindings/${request}/review`, headers: doctor.headers, payload: { approved: true, verificationMethod: '核对身份' } })).statusCode, 409);
});

// Catches reactivation/role conversion and weak credential validation.
test('web accounts: disabled and nonpatient bindings cannot be converted, credentials are validated', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician'); const p = await boundPatient(f.db, doctor.id);
  await f.db.query('UPDATE accounts SET disabled=true WHERE id=$1', [p.user.id]);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p.patientId}/web-account`, headers: doctor.headers, payload: { username: 'valid.name' } })).statusCode, 409);
  await f.db.query("UPDATE accounts SET disabled=false,role='clinician' WHERE id=$1", [p.user.id]);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${p.patientId}/web-account`, headers: doctor.headers, payload: { username: 'valid.name' } })).statusCode, 409);
  const id = await patient(f.db, doctor.id);
  for (const username of ['ab', 'bad name', 'a'.repeat(81)]) assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/clinician/patients/${id}/web-account`, headers: doctor.headers, payload: { username } })).statusCode, 400);
  const setup = await provision(f, doctor, id, 'Case.Name');
  assert.equal((await login(f, 'case.name', setup.temporaryPassword)).statusCode, 401);
  const r = await login(f, setup.username, setup.temporaryPassword);
  for (const newPassword of ['short', 'a'.repeat(129), setup.temporaryPassword]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/patient/auth/password', headers: { cookie: cookie(r), 'x-csrf-token': r.json().csrfToken }, payload: { currentPassword: setup.temporaryPassword, newPassword } });
    assert.equal(response.statusCode, 400, response.body);
  }
});

// Catches legacy approval falsely succeeding when the patient was bound meanwhile.
test('web accounts: legacy binding approval cannot report success over an existing binding', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician'); const p = await boundPatient(f.db, doctor.id); const applicant = await identity(f.db, 'patient');
  const inv = randomUUID(); const request = randomUUID();
  await f.db.query("INSERT INTO patient_invitations(id,patient_id,clinician_id,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')", [inv, p.patientId, doctor.id, digest('STALE-CODE')]);
  await f.db.query('INSERT INTO binding_requests(id,invitation_id,patient_id,account_id,evidence) VALUES($1,$2,$3,$4,$5)', [request, inv, p.patientId, applicant.id, {}]);
  const r = await f.app.inject({ method: 'POST', url: `/api/v1/clinician/bindings/${request}/review`, headers: doctor.headers, payload: { approved: true, verificationMethod: '核对身份' } });
  assert.equal(r.statusCode, 409);
  assert.equal((await f.db.query('SELECT account_id FROM patient_records WHERE id=$1', [p.patientId])).rows[0].account_id, p.user.id);
  assert.equal((await f.db.query('SELECT status FROM binding_requests WHERE id=$1', [request])).rows[0].status, 'pending');
});

// Catches a session generation check removed from durable work after auth succeeds.
test('web auth: durable commits recheck credential generation under the reset account lock', async t => {
  const f = await httpFixture(t); const doctor = await identity(f.db, 'clinician'); const p = await boundPatient(f.db, doctor.id);
  const auth = (await f.db.query('SELECT id FROM auth_sessions WHERE account_id=$1', [p.user.id])).rows[0];
  const captured = { accountId: p.user.id, sessionId: auth.id, role: 'patient' as const, kind: 'patient' as const, csrfToken: null, displayName: '患者' };
  await f.db.transaction(tx => assertActiveSession(tx, captured, true));
  await f.db.query('UPDATE accounts SET credential_version=credential_version+1 WHERE id=$1', [p.user.id]);
  await assert.rejects(() => f.db.transaction(tx => assertActiveSession(tx, captured, true)), (e: any) => e.code === 'UNAUTHENTICATED');
  assert.equal((await f.app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).statusCode, 401);
});
