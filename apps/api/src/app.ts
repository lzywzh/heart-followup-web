import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { validateConfig } from './config.js';
import { registerAuth } from './modules/auth.js';
import { registerWebAccounts } from './modules/web-accounts.js';
import { registerBindings } from './modules/bindings.js';
import { registerPatients } from './modules/patients.js';
import { registerTasks } from './modules/tasks.js';
import { registerFollowups } from './modules/followups.js';
import { registerVoice } from './voice/gateway.js';
import { registerBrowserVoice } from './voice/browser.js';
import type { Context } from './modules/context.js';

export async function createApp(options: Omit<Context,'app'|'providers'> & { providers?: Record<string,any> }) {
  validateConfig(options.config);
  const app = Fastify({ logger: false, bodyLimit: 1_500_000, trustProxy: ['127.0.0.1','::1'], requestTimeout: 60000 });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  await app.register(websocket,{options:{maxPayload:100000,perMessageDeflate:false}});
  const context = { ...options, app, providers: options.providers || {} };
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('cache-control','no-store'); return payload;
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues[0]?.message || '输入有误', requestId: req.id } });
    const status = err instanceof AppError ? err.statusCode : err.statusCode === 429 ? 429 : err.code === '23505' ? 409 : (err.statusCode>=400&&err.statusCode<500)?400:500;
    if(status===500)console.error(JSON.stringify({event:'api.error',requestId:req.id,code:/^(?:FST_[A-Z_]+|[0-9A-Z]{5})$/.test(err.code||'')?err.code:'UNEXPECTED'}));
    if(status===400&&!(err instanceof AppError))return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'请求格式不正确，请检查输入后重试',requestId:req.id}});
    return reply.code(status).send({ error: { code: err instanceof AppError ? err.code : status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR', message: status === 500 ? '服务暂时遇到问题，请稍后重试' : status === 409 ? (err instanceof AppError ? err.message : '资料已变更或记录重复，请刷新重试') : status === 429 ? '操作频繁，请稍后再试' : err.message, requestId: req.id } });
  });
  app.get('/api/v1/health', async () => { await options.db.query('SELECT 1'); return { ok: true, version: '0.1.0', environment: options.config.nodeEnv, authMode: options.config.authMode, collectionMode: options.config.collectionMode }; });
  await registerAuth(context); await registerWebAccounts(context); await registerBindings(context); await registerPatients(context); await registerTasks(context);
  await registerFollowups(context);
  await registerVoice(context);
  await registerBrowserVoice(context);
  return app;
}
