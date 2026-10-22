import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { accounts } from '../db/schema.js';
import type { Database } from '../db/database.js';
import { AppError, unavailable } from '../errors.js';
import { audit, digest, requireIdentity, type Context } from './context.js';
import type { Role } from '@heart/contracts';
const scrypt = promisify(scryptCb);
const randomToken = () => randomBytes(32).toString('hex');

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const result = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${result.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string | null) {
  if (!hash?.startsWith('scrypt:')) { await scrypt(password, 'invalid-user-dummy-salt', 64); return false; }
  const [, salt, value] = hash.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function accountView(account: any) {
  return { id: account.id, role: account.role, displayName: account.display_name, mustChangePassword: Boolean(account.must_change_password) };
}

export async function browserSession(db: Database, account: any) {
  const token = randomToken(); const csrfToken = randomToken();
  await db.query(`INSERT INTO auth_sessions(id,account_id,access_hash,csrf_token,kind,expires_at,credential_version)
    VALUES($1,$2,$3,$4,'web',now()+interval '8 hours',$5)`, [randomUUID(), account.id, digest(token), csrfToken, account.credential_version]);
  return { token, csrfToken, account: accountView(account), expiresIn: 28800 };
}

export async function registerAuth({ app, db, config, providers }: Context) {
  app.addHook('preHandler', async (req, reply) => {
    const bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const path = req.url.split('?')[0];
    const patientPath = path.startsWith('/api/v1/patient/') || path.startsWith('/api/v1/voice/');
    const cookie = patientPath ? req.cookies.hf_patient_session : req.cookies.hf_session;
    const raw = bearer || cookie;
    if (!raw) return;
    const r = await db.query(`SELECT s.*,a.role,a.display_name,a.wx_openid,a.must_change_password FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT a.disabled AND s.credential_version=a.credential_version`, [digest(raw)]);
    const session = r.rows[0]; if (!session) return;
    if(config.nodeEnv==='production'&&session.wx_openid?.startsWith('dev:'))return;
    if ((bearer && session.kind !== 'patient') || (!bearer && session.kind !== 'web')) return;
    if (!bearer && (patientPath ? session.role !== 'patient' : !['clinician','admin'].includes(session.role))) return;
    req.identity = { accountId: session.account_id, role: session.role, displayName: session.display_name, sessionId: session.id, kind: session.kind, csrfToken: session.csrf_token };
    const isPublicAuth = ['/api/v1/auth/clinician/login','/api/v1/auth/wechat/login','/api/v1/auth/development','/api/v1/auth/refresh','/api/v1/patient/auth/login'].includes(path);
    if (!isPublicAuth && session.kind === 'web' && !['GET','HEAD','OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf_token) {
      throw new AppError(403, 'CSRF_REJECTED', '登录状态需要刷新，请重新打开页面');
    }
    if (!isPublicAuth && session.role === 'patient' && session.must_change_password && !['/api/v1/patient/auth/session','/api/v1/patient/auth/password','/api/v1/patient/auth/logout'].includes(path)) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码');
  });

  async function sessionFor(account: { id: string; role: Role; displayName: string }, kind: 'web' | 'patient') {
    const token = randomToken(); const refreshToken = kind === 'patient' ? randomToken() : null;
    const csrfToken = kind === 'web' ? randomToken() : null;
    const ttl = kind === 'web' ? '8 hours' : '30 minutes';
    await db.query(`INSERT INTO auth_sessions(id,account_id,access_hash,refresh_hash,csrf_token,kind,expires_at,refresh_expires_at,credential_version) SELECT $1,id,$3,$4,$5,$6,now()+$7::interval,CASE WHEN $4::text IS NULL THEN NULL ELSE now()+interval '14 days' END,credential_version FROM accounts WHERE id=$2`,
      [randomUUID(), account.id, digest(token), refreshToken ? digest(refreshToken) : null, csrfToken, kind, ttl]);
    const state = (await db.query('SELECT must_change_password FROM accounts WHERE id=$1', [account.id])).rows[0];
    return { token, refreshToken, csrfToken, account: { id: account.id, role: account.role, displayName: account.displayName, mustChangePassword: Boolean(state.must_change_password) }, expiresIn: kind === 'web' ? 28800 : 1800 };
  }

  app.post('/api/v1/auth/clinician/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const b = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200) }).strict().parse(req.body);
    const [user] = await db.orm.select().from(accounts).where(eq(accounts.loginName, b.username));
    const valid = await verifyPassword(b.password, user?.passwordHash || null);
    if (!valid || !user || user.disabled || !['clinician','admin'].includes(user.role)) throw new AppError(401, 'LOGIN_FAILED', '账号或密码不正确');
    const session = await sessionFor({ id: user.id, role: user.role as Role, displayName: user.displayName }, 'web');
    reply.setCookie('hf_session', session.token, { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/', maxAge: session.expiresIn });
    await audit(db, user.id, 'login', 'account', user.id);
    return { account: session.account, csrfToken: session.csrfToken };
  });

  async function patientLogin(openid: string, name = '患者') {
    const r = await db.query(`INSERT INTO accounts(id,role,display_name,wx_openid) VALUES($1,'patient',$2,$3) ON CONFLICT(wx_openid) DO UPDATE SET wx_openid=excluded.wx_openid RETURNING *`, [randomUUID(), name, openid]);
    const a = r.rows[0]; if (a.disabled) throw new AppError(403, 'ACCOUNT_DISABLED', '账户已停用，请联系负责医生');
    return sessionFor({ id: a.id, role: 'patient', displayName: a.display_name }, 'patient');
  }

  app.post('/api/v1/auth/wechat/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    if ((config.authMode as string) === 'web') throw new AppError(404, 'NOT_FOUND', '接口不存在');
    const b = z.object({ code: z.string().min(1).max(256), consentAccepted: z.literal(true) }).strict().parse(req.body);
    if (!config.wxAppSecret) throw unavailable('微信登录尚未配置，请联系管理员');
    const query = new URLSearchParams({ appid: config.wxAppId, secret: config.wxAppSecret, js_code: b.code, grant_type: 'authorization_code' });
    let result: any;
    try { const response = await (providers.fetch || fetch)(`https://api.weixin.qq.com/sns/jscode2session?${query}`, { signal: AbortSignal.timeout(10000) }); result = await response.json(); }
    catch { throw unavailable('微信登录暂未响应，请稍后重试'); }
    if (!result.openid || result.errcode) throw new AppError(401, 'WECHAT_LOGIN_FAILED', '微信登录凭证已失效，请重试');
    return patientLogin(result.openid);
  });

  app.post('/api/v1/auth/development', async req => {
    if (config.authMode !== 'development' || config.nodeEnv === 'production' || !['127.0.0.1','::1'].includes(req.ip)) throw new AppError(404, 'NOT_FOUND', '接口不存在');
    const b = z.object({ identity: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), consentAccepted: z.literal(true) }).strict().parse(req.body);
    return { ...await patientLogin('dev:' + b.identity, '本地测试患者'), developmentOnly: true };
  });

  app.post('/api/v1/auth/refresh', async req => {
    const { refreshToken } = z.object({ refreshToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const r = await tx.query(`SELECT s.*,a.role,a.display_name,a.wx_openid,a.must_change_password FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.refresh_hash=$1 AND s.kind='patient' AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND NOT a.disabled AND s.credential_version=a.credential_version FOR UPDATE OF a,s`, [digest(refreshToken)]);
      if (!r.rowCount) throw new AppError(401, 'REFRESH_FAILED', '登录已过期，请重新登录');
      const s = r.rows[0];
      if(config.nodeEnv==='production'&&s.wx_openid?.startsWith('dev:'))throw new AppError(401,'REFRESH_FAILED','开发登录不能用于生产环境');
      const token = randomToken(); const next = randomToken();
      await tx.query("UPDATE auth_sessions SET access_hash=$1,refresh_hash=$2,expires_at=now()+interval '30 minutes' WHERE id=$3", [digest(token), digest(next), s.id]);
      return { token, refreshToken: next, expiresIn: 1800, account: { id: s.account_id, role: s.role, displayName: s.display_name, mustChangePassword: Boolean(s.must_change_password) } };
    });
  });

  app.get('/api/v1/auth/session', async req => { const i = requireIdentity(req); const a = (await db.query('SELECT * FROM accounts WHERE id=$1', [i.accountId])).rows[0]; return { account: accountView(a), csrfToken: i.csrfToken }; });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const i = requireIdentity(req);
    await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [i.sessionId]);
    reply.clearCookie('hf_session', { path: '/' }); return { ok: true };
  });
}
