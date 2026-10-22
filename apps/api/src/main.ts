import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { readConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { createApp } from './app.js';
import { startWorker } from './jobs/worker.js';

const config=readConfig();
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required; run setup:local first');
const db=createDatabase(process.env.DATABASE_URL);
try{
  await db.query('SELECT version FROM schema_migrations LIMIT 1');
  const app=await createApp({db,config});
  const doctorRoot=fileURLToPath(new URL('../../clinician-web/dist/',import.meta.url));
  const patientRoot=fileURLToPath(new URL('../../patient-web/dist/',import.meta.url));
  if(!existsSync(doctorRoot)||!existsSync(patientRoot))throw new Error('Frontend builds are required');
  await app.register(fastifyStatic,{root:doctorRoot,prefix:'/doctor/'});
  await app.register(fastifyStatic,{root:patientRoot,prefix:'/patient/',decorateReply:false});
  app.get('/',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>心伴随访</title><style>body{margin:0;background:#f2f7f6;color:#183832;font-family:system-ui,sans-serif}main{max-width:660px;margin:12vh auto;padding:28px}h1{font-size:34px}p{line-height:1.8;color:#58706a}nav{display:grid;gap:18px;margin-top:32px}a{display:block;padding:26px;border-radius:18px;background:white;border:1px solid #dce8e3;text-decoration:none;color:#176857;box-shadow:0 8px 32px #164c3b08;font-size:22px}small{display:block;margin-top:10px;color:#647c75;font-size:15px}</style></head><body><main><h1>心伴随访</h1><p>选择您的入口，登录后继续。</p><nav><a href="/patient/">患者入口<small>语音随访 · 个人信息 · 随访小结</small></a><a href="/doctor/">医生工作台<small>患者档案 · 随访安排 · 小结审核</small></a></nav></main></body></html>`));
  app.get('/platform',async(_req,reply)=>reply.redirect('/doctor/'));
  app.get('/platform/*',async(_req,reply)=>reply.redirect('/doctor/'));
  app.setNotFoundHandler((req,reply)=>{
    if(req.method==='GET'&&req.url.startsWith('/doctor/')&&!req.url.split('?')[0].includes('.'))return reply.sendFile('index.html',doctorRoot);
    if(req.method==='GET'&&req.url.startsWith('/patient/')&&!req.url.split('?')[0].includes('.'))return reply.sendFile('index.html',patientRoot);
    return reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在'}});
  });
  const stopWorker=startWorker({db,config,providers:{}});
  app.addHook('onClose',async()=>{await stopWorker();await db.close();});
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();};
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  await app.listen({host:config.host,port:config.port});
  console.log(`心伴随访患者端 / 医生工作台：http://${config.host}:${config.port}`);
  console.log(`环境：${config.nodeEnv}；采集模式：${config.collectionMode}；语音需独立配置。`);
}catch{await db.close();console.error('服务启动失败，请检查数据库、迁移和端口配置。敏感配置未输出。');process.exitCode=1;}
