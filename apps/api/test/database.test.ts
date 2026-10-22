import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, account, patient } from './fixture.js';
import { migrate } from '../src/db/migrate.js';

test('database: migration rerun preserves existing records', async t => {
  const f = await testDatabase(); t.after(f.dispose);
  const id = await account(f.db, 'clinician');
  await migrate(f.db);
  const r = await f.db.query('SELECT id FROM accounts WHERE id=$1', [id]);
  assert.equal(r.rows[0].id, id);
});

test('database: rollback prevents partially created patient records', async t => {
  const f = await testDatabase(); t.after(f.dispose);
  const doctor = await account(f.db, 'clinician');
  await assert.rejects(f.db.transaction(async tx => {
    await patient(tx, doctor);
    throw new Error('cancel');
  }));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM patient_records')).rows[0].n, 0);
});

test('database: a patient cannot have two active follow-up sessions', async t => {
  const f = await testDatabase(); t.after(f.dispose);
  const doctor = await account(f.db, 'clinician');
  const p = await patient(f.db, doctor);
  await f.db.query('INSERT INTO followup_sessions(id,patient_id,clinician_id) VALUES($1,$2,$3)', [randomUUID(), p, doctor]);
  await assert.rejects(f.db.query('INSERT INTO followup_sessions(id,patient_id,clinician_id) VALUES($1,$2,$3)', [randomUUID(), p, doctor]), { code: '23505' });
});

test('database: an account cannot bind to two patient records', async t => {
  const f = await testDatabase(); t.after(f.dispose);
  const doctor = await account(f.db, 'clinician');
  const user = await account(f.db, 'patient');
  const p = await patient(f.db, doctor);
  const p2 = await patient(f.db, doctor);
  await f.db.query('UPDATE patient_records SET account_id=$1 WHERE id=$2', [user, p]);
  await assert.rejects(f.db.query('UPDATE patient_records SET account_id=$1 WHERE id=$2', [user, p2]), { code: '23505' });
});
