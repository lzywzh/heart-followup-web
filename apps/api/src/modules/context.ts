import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Identity, Role } from '@heart/contracts';
import { AppError, notFound } from '../errors.js';
import { createHash, randomUUID } from 'node:crypto';

declare module 'fastify' { interface FastifyRequest { identity?: Identity; } }
export interface Context { app: FastifyInstance; db: Database; config: AppConfig; providers: Record<string, any>; }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Call inside the durable commit transaction with lock=true to fence credential resets. */
export async function assertActiveSession(db: Database, identity: Identity, lock = false, production = false): Promise<void> {
  // Lock the account before reading the session: password reset takes this same lock.
  if (lock) await db.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [identity.accountId]);
  const r = await db.query(`SELECT a.must_change_password,a.wx_openid FROM auth_sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.id=$1 AND s.account_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT a.disabled
      AND s.credential_version=a.credential_version AND a.role=$3 AND s.kind=$4`, [identity.sessionId, identity.accountId, identity.role, identity.kind]);
  const a = r.rows[0];
  if (!a || (production && a.wx_openid?.startsWith('dev:'))) throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
  if (identity.role === 'patient' && a.must_change_password) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码');
}
export function requireIdentity(request: FastifyRequest, role?: Role): Identity {
  const identity = request.identity;
  if (!identity) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  if (role && identity.role !== role) throw new AppError(403, 'FORBIDDEN', '无权执行此操作');
  return identity;
}
export async function ownPatient(db: Database, identity: Identity, id?: string) {
  const r = identity.role === 'patient'
    ? await db.query('SELECT * FROM patient_records WHERE account_id=$1' + (id ? ' AND id=$2' : ''), id ? [identity.accountId, id] : [identity.accountId])
    : await db.query('SELECT * FROM patient_records WHERE clinician_id=$1 AND id=$2', [identity.accountId, id]);
  if (!r.rowCount) throw notFound();
  return r.rows[0];
}
export async function audit(db: Database, actor: string | null, action: string, targetType: string, targetId?: string, metadata: unknown = {}) {
  await db.query('INSERT INTO audit_events(id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), actor, action, targetType, targetId || null, metadata]);
}
