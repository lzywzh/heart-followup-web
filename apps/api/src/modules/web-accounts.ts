import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '@heart/contracts';
import { AppError, conflict, notFound } from '../errors.js';
import { accountView, browserSession, hashPassword, verifyPassword } from './auth.js';
import { audit, requireIdentity, type Context } from './context.js';

// Usernames are case-sensitive, matching existing clinician login names.
const usernameSchema = z.string().trim().regex(/^[A-Za-z0-9_.-]{3,80}$/);
const passwordSchema = z.string().min(10).max(128);
const accountStatus = (a?: any) => ({
  enabled: Boolean(a && !a.disabled && a.role === 'patient' && a.login_name && a.password_hash),
  accountId: a?.id || null, username: a?.login_name || null,
  mustChangePassword: Boolean(a?.must_change_password), disabled: Boolean(a?.disabled),
});

export async function registerWebAccounts({ app, db, config }: Context) {
  const setPatientCookie = (reply: any, session: Awaited<ReturnType<typeof browserSession>>) => {
    reply.setCookie('hf_patient_session', session.token, { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/', maxAge: session.expiresIn });
    return { account: session.account, csrfToken: session.csrfToken };
  };
  app.post('/api/v1/patient/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const a = (await tx.query('SELECT * FROM accounts WHERE login_name=$1 FOR UPDATE', [body.username])).rows[0];
      const valid = await verifyPassword(body.password, a?.password_hash || null);
      if (!valid || !a || a.disabled || a.role !== 'patient' || (config.nodeEnv === 'production' && a.wx_openid?.startsWith('dev:'))) throw new AppError(401, 'LOGIN_FAILED', '账号或密码不正确');
      const session = await browserSession(tx, a);
      await audit(tx, a.id, 'login', 'account', a.id);
      return setPatientCookie(reply, session);
    });
  });

  app.get('/api/v1/patient/auth/session', async req => {
    const i = requireIdentity(req, 'patient');
    const a = (await db.query('SELECT * FROM accounts WHERE id=$1', [i.accountId])).rows[0];
    return { account: accountView(a), csrfToken: i.csrfToken };
  });
  app.post('/api/v1/patient/auth/logout', async (req, reply) => {
    const i = requireIdentity(req, 'patient');
    await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [i.sessionId]);
    reply.clearCookie('hf_patient_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/v1/patient/auth/password', async (req, reply) => {
    const i = requireIdentity(req, 'patient');
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict().parse(req.body);
    if (body.currentPassword === body.newPassword) throw new AppError(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
    return db.transaction(async tx => {
      const a = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [i.accountId])).rows[0];
      const session = (await tx.query('SELECT id FROM auth_sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>now() AND credential_version=$3', [i.sessionId, i.accountId, a?.credential_version])).rows[0];
      if (!session || !a || a.disabled || a.role !== 'patient') throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
      if (!await verifyPassword(body.currentPassword, a.password_hash)) throw new AppError(401, 'PASSWORD_INCORRECT', '当前密码不正确');
      const changed = (await tx.query('UPDATE accounts SET password_hash=$1,must_change_password=false,credential_version=credential_version+1 WHERE id=$2 RETURNING *', [await hashPassword(body.newPassword), a.id])).rows[0];
      await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL', [a.id]);
      const next = await browserSession(tx, changed);
      await audit(tx, a.id, 'web_account.password.change', 'account', a.id);
      return setPatientCookie(reply, next);
    });
  });

  app.get('/api/v1/clinician/patients/:id/web-account', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const p = (await db.query('SELECT account_id FROM patient_records WHERE id=$1 AND clinician_id=$2', [id, i.accountId])).rows[0];
    if (!p) throw notFound();
    const a = p.account_id ? (await db.query('SELECT * FROM accounts WHERE id=$1', [p.account_id])).rows[0] : undefined;
    return accountStatus(a);
  });
  app.post('/api/v1/clinician/patients/:id/web-account', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const { username } = z.object({ username: usernameSchema }).strict().parse(req.body);
    return db.transaction(async tx => {
      const p = (await tx.query('SELECT * FROM patient_records WHERE id=$1 AND clinician_id=$2 FOR UPDATE', [id, i.accountId])).rows[0];
      if (!p) throw notFound();
      let a = p.account_id ? (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [p.account_id])).rows[0] : undefined;
      if (p.account_id && (!a || a.disabled || a.role !== 'patient')) throw conflict('绑定账户已停用或类型不正确，请联系管理员');
      const temporaryPassword = randomBytes(18).toString('base64url');
      const passwordHash = await hashPassword(temporaryPassword);
      const isNew = !a;
      if (a) {
        a = (await tx.query('UPDATE accounts SET login_name=$1,password_hash=$2,must_change_password=true,credential_version=credential_version+1 WHERE id=$3 RETURNING *', [username, passwordHash, a.id])).rows[0];
      } else {
        a = (await tx.query("INSERT INTO accounts(id,role,display_name,login_name,password_hash,must_change_password,credential_version) VALUES($1,'patient',$2,$3,$4,true,1) RETURNING *", [randomUUID(), p.name, username, passwordHash])).rows[0];
        await tx.query('UPDATE patient_records SET account_id=$1,updated_at=now() WHERE id=$2', [a.id, p.id]);
      }
      await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL', [a.id]);
      // All binding workflows take the patient lock first, so invitation approval cannot win later.
      await tx.query('UPDATE patient_invitations SET revoked_at=now() WHERE patient_id=$1 AND revoked_at IS NULL', [id]);
      await tx.query("UPDATE binding_requests SET status='expired' WHERE patient_id=$1 AND status='pending'", [id]);
      await audit(tx, i.accountId, isNew ? 'web_account.create' : 'web_account.reset', 'patient', id, { accountId: a.id });
      return { ...accountStatus(a), temporaryPassword };
    });
  });
}
