import { randomBytes,randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Identity } from '@heart/contracts';
import { digest } from '../modules/context.js';
import { notFound } from '../errors.js';

export async function issueTicket(db:Database,identity:Identity,session:any,kind:'socket'|'audio',resourceId?:string){
  const token=randomBytes(32).toString('hex');
  await db.query("INSERT INTO voice_tickets(id,account_id,auth_session_id,session_id,token_hash,kind,session_version,resource_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '90 seconds')",[randomUUID(),identity.accountId,identity.sessionId,session.id,digest(token),kind,session.version,resourceId||null]);
  return token;
}
export async function consumeTicket(db:Database,token:string,kind:'socket'|'audio',accountId?:string,resourceId?:string,allowDevelopment=true){
  if(!/^[a-f0-9]{64}$/.test(token))throw notFound();
  return db.transaction(async tx=>{
    const r=await tx.query(`SELECT t.*,s.version,s.status,a.display_name FROM voice_tickets t JOIN followup_sessions s ON s.id=t.session_id JOIN patient_records p ON p.id=s.patient_id JOIN accounts a ON a.id=t.account_id JOIN auth_sessions auth ON auth.id=t.auth_session_id WHERE t.token_hash=$1 AND t.kind=$2 AND t.expires_at>now() AND t.used_at IS NULL AND NOT a.disabled AND auth.revoked_at IS NULL AND auth.expires_at>now() AND p.account_id=t.account_id AND ($3::boolean OR a.wx_openid IS NULL OR a.wx_openid NOT LIKE 'dev:%') FOR UPDATE OF t`,[digest(token),kind,allowDevelopment]);
    const t=r.rows[0];if(!t||t.version!==t.session_version||(accountId&&t.account_id!==accountId)||(resourceId&&t.resource_id!==resourceId))throw notFound();
    if(kind==='socket'&&!['active','awaiting_confirmation'].includes(t.status))throw notFound();
    await tx.query('UPDATE voice_tickets SET used_at=now() WHERE id=$1',[t.id]);return t;
  });
}
