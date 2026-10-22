import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
config({ path: '.env', quiet: true });

export async function testDatabase(): Promise<{ db: Database; dispose: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Tests require a dedicated *_test PostgreSQL database');
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createDatabase(url, schema);
  try { await migrate(db); }
  catch (error) { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
  return {
    db,
    dispose: async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); },
  };
}

export async function account(db: Database, role: 'clinician' | 'patient' | 'admin', name = role): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO accounts(id,role,display_name) VALUES ($1,$2,$3)', [id, role, name]);
  return id;
}

export async function patient(db: Database, clinicianId: string, name = '测试患者'): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO patient_records(id,clinician_id,name,birth_date) VALUES($1,$2,$3,'1980-01-01')`, [id, clinicianId, name]);
  return id;
}
