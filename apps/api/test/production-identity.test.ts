import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import {httpFixture,testConfig,boundPatient,identity} from './http-fixture.js';
import {consumeTicket,issueTicket} from '../src/voice/tickets.js';
test('auth: production rejects development bearer and refresh already issued in the same database',async t=>{
  const f=await httpFixture(t);const login=(await f.app.inject({method:'POST',url:'/api/v1/auth/development',payload:{identity:'cross-env',consentAccepted:true}})).json();
  const production=await createApp({db:f.db,config:{...testConfig,nodeEnv:'production',authMode:'wechat',collectionMode:'ai'}});t.after(()=>production.close());
  assert.equal((await production.inject({url:'/api/v1/patient/me',headers:{authorization:'Bearer '+login.token}})).statusCode,401);
  assert.equal((await production.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken:login.refreshToken}})).statusCode,401);
  const doctor=await identity(f.db,'clinician');const patient=await boundPatient(f.db,doctor.id);
  await f.db.query('UPDATE patient_records SET account_id=$1 WHERE id=$2',[login.account.id,patient.patientId]);
  const session=(await f.app.inject({method:'POST',url:'/api/v1/patient/followups',headers:{authorization:'Bearer '+login.token},payload:{clientRequestId:'production-ticket-check'}})).json();
  const auth=(await f.db.query('SELECT id FROM auth_sessions WHERE account_id=$1',[login.account.id])).rows[0];
  const ticket=await issueTicket(f.db,{accountId:login.account.id,sessionId:auth.id,role:'patient',kind:'patient',csrfToken:null,displayName:'开发患者'},session,'socket');
  await assert.rejects(()=>consumeTicket(f.db,ticket,'socket',undefined,undefined,false));
});
