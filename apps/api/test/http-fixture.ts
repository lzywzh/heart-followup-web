import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Database } from '../src/db/database.js';
import { createApp } from '../src/app.js';
import { testDatabase, account, patient } from './fixture.js';
import type { AppConfig } from '../src/config.js';

export const testConfig: AppConfig = {
  nodeEnv: 'test', authMode: 'development', collectionMode: 'scripted', host: '127.0.0.1', port: 3100,
  publicOrigin: 'http://localhost:3100', sessionSecret: 'test-secret-long-enough-for-this-test-fixture',
  wxAppId: 'test-app', wxAppSecret: '', deepseekApiKey: '', deepseekModel: '',
  aliyunAsrAppKey: '', aliyunAccessKeyId: '', aliyunAccessKeySecret: '', aliyunAsrUrl: 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1',
  dashscopeApiKey: '', dashscopeUrl: '', ttsModel: '', ttsVoice: '', protocolApproved: false,
};

export async function httpFixture(t: TestContext, override: Partial<AppConfig> = {}, providers: any = {}) {
  const f = await testDatabase();
  const app = await createApp({ db: f.db, config: { ...testConfig, ...override }, providers });
  t.after(async () => { await app.close(); await f.dispose(); });
  return { ...f, app };
}

export async function identity(db: Database, role: 'clinician' | 'patient' | 'admin') {
  const id = await account(db, role);
  const token = randomBytes(32).toString('hex'); const csrf = randomBytes(16).toString('hex');
  await db.query(`INSERT INTO auth_sessions(id,account_id,access_hash,csrf_token,kind,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`,
    [randomUUID(), id, createHash('sha256').update(token).digest('hex'), csrf, role === 'patient' ? 'patient' : 'web']);
  const headers = role === 'patient' ? { authorization: `Bearer ${token}` } : { cookie: `hf_session=${token}`, 'x-csrf-token': csrf };
  return { id, token, csrf, headers };
}

export async function boundPatient(db: Database, doctorId?: string) {
  const doctor = doctorId ? { id: doctorId } : await identity(db, 'clinician');
  const user = await identity(db, 'patient');
  const id = await patient(db, doctor.id);
  await db.query('UPDATE patient_records SET account_id=$1 WHERE id=$2', [user.id, id]);
  return { doctor, user, patientId: id };
}
