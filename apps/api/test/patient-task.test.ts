import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, identity, boundPatient } from './http-fixture.js';

test('profiles: patients edit contact details but cannot change doctor-maintained records', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const p = await boundPatient(db, doctor.id);
  const update = await app.inject({ method: 'PATCH', url: '/api/v1/patient/me', headers: p.user.headers, payload: { phone: '13800000000', emergencyContact: '家属', personalNotes: '晚上方便接听' } });
  assert.equal(update.statusCode, 200);
  const view = (await app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).json().patient;
  assert.equal(view.phone, '13800000000'); assert.equal(view.birthDate, '1980-01-01');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/patient/me', headers: p.user.headers, payload: { medicalRecord: { diagnosis: '替换诊断' } } })).statusCode, 400);
  const correction = await app.inject({ method: 'POST', url: '/api/v1/patient/me/corrections', headers: p.user.headers, payload: { content: '出院日期需要医生核实' } });
  assert.equal(correction.statusCode, 201);
  const detail = await app.inject({ url: `/api/v1/clinician/patients/${p.patientId}`, headers: doctor.headers });
  assert.equal(detail.json().corrections.length, 1);
});

test('profiles: doctor edits are versioned and another doctor cannot read or modify records', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const other = await identity(db, 'clinician'); const p = await boundPatient(db, doctor.id);
  const medical = { expectedVersion: 1, record: { diagnosis: '待核实的测试记录', carePlan: '按原医嘱随访' } };
  const saved = await app.inject({ method: 'PUT', url: `/api/v1/clinician/patients/${p.patientId}/medical-record`, headers: doctor.headers, payload: medical });
  assert.equal(saved.statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/clinician/patients/${p.patientId}/medical-record`, headers: doctor.headers, payload: medical })).statusCode, 409);
  assert.equal((await app.inject({ url: `/api/v1/clinician/patients/${p.patientId}`, headers: other.headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/clinician/patients/${p.patientId}/medical-record`, headers: other.headers, payload: { ...medical, expectedVersion: 2 } })).statusCode, 404);
  assert.equal((await db.query('SELECT count(*)::int n FROM medical_record_versions')).rows[0].n, 1);
});

test('tasks: created tasks appear only in the owning patient workspace, with future opening and overdue flags', async t => {
  const { app, db } = await httpFixture(t);
  const doctor = await identity(db, 'clinician'); const p = await boundPatient(db, doctor.id); const other = await boundPatient(db, doctor.id);
  const scheduledAt = new Date(Date.now() + 72 * 3600000).toISOString();
  const created = await app.inject({ method: 'POST', url: '/api/v1/clinician/tasks', headers: doctor.headers, payload: { patientId: p.patientId, title: '出院后随访', scheduledAt } });
  assert.equal(created.statusCode, 201);
  const mine = (await app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).json();
  assert.equal(mine.tasks.length, 1); assert.equal(mine.tasks[0].available, false); assert.equal(mine.tasks[0].overdue, false);
  assert.equal((await app.inject({ url: '/api/v1/patient/me', headers: other.user.headers })).json().tasks.length, 0);
  await db.query("UPDATE followup_tasks SET scheduled_at=now()-interval '1 hour', opens_at=now()-interval '25 hours' WHERE id=$1", [created.json().id]);
  assert.equal((await app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).json().tasks[0].overdue, true);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/clinician/tasks/${created.json().id}`, headers: doctor.headers, payload: { cancelled: true } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/patient/me', headers: p.user.headers })).json().tasks[0].overdue, false);
});

test('profiles: clinician creates a persisted patient without creating a fake patient login', async t => {
  const { app, db } = await httpFixture(t); const d = await identity(db, 'clinician');
  const r = await app.inject({ method: 'POST', url: '/api/v1/clinician/patients', headers: d.headers, payload: { name: '张某', birthDate: '1960-12-01', sex: 'female' } });
  assert.equal(r.statusCode, 201);
  assert.equal((await db.query("SELECT count(*)::int n FROM accounts WHERE role='patient'")).rows[0].n, 0);
  assert.equal((await app.inject({ url: '/api/v1/clinician/patients', headers: d.headers })).json().items[0].name, '张某');
});
