import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema,messageSchema,correctionSchema } from '@heart/contracts';
import { audit,requireIdentity,type Context } from './context.js';
import { conflict } from '../errors.js';
import { createFollowupService,ownedSession,turnsFor } from '../followups/service.js';
import { PROTOCOL_VERSION,FIELDS,LABELS,QUESTIONS } from '../agents/protocol.js';
import { briefSummary } from '../followups/brief-summary.js';

export async function registerFollowups(context:Context) {
  const {app,db,config}=context; const service=createFollowupService(context);
  app.post('/api/v1/patient/followups',async(req,reply)=>{
    const i=requireIdentity(req,'patient'); const b=z.object({clientRequestId:z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),taskId:idSchema.optional()}).strict().parse(req.body);
    const result=await service.start(i,b); reply.code(result.created?201:200); return result.session;
  });
  app.get('/api/v1/patient/followups/:id',async req=>service.view(requireIdentity(req,'patient'),idSchema.parse((req.params as any).id)));
  app.post('/api/v1/patient/followups/:id/messages',async req=>service.message(requireIdentity(req,'patient'),idSchema.parse((req.params as any).id),messageSchema.parse(req.body)));
  app.post('/api/v1/patient/followups/:id/corrections',async req=>service.message(requireIdentity(req,'patient'),idSchema.parse((req.params as any).id),correctionSchema.parse(req.body)));
  for(const action of ['pause','resume']) app.post(`/api/v1/patient/followups/:id/${action}`,async req=>service.pause(requireIdentity(req,'patient'),idSchema.parse((req.params as any).id),action==='resume'));
  app.post('/api/v1/patient/followups/:id/submit',async req=>service.submit(requireIdentity(req,'patient'),idSchema.parse((req.params as any).id),z.object({expectedVersion:z.number().int().positive(),confirmed:z.boolean()}).strict().parse(req.body)));

  app.get('/api/v1/clinician/reviews',async req=>{
    const i=requireIdentity(req,'clinician'); const r=await db.query("SELECT s.id,s.patient_id,s.status,s.priority,s.review_status,s.started_at,s.submitted_at,s.patient_confirmed,p.name FROM followup_sessions s JOIN patient_records p ON p.id=s.patient_id WHERE p.clinician_id=$1 AND s.status IN ('submitted','handoff') ORDER BY (s.priority='urgent') DESC,s.started_at DESC LIMIT 300",[i.accountId]); return {items:r.rows};
  });
  app.get('/api/v1/clinician/followups/:id',async req=>{
    const i=requireIdentity(req,'clinician'); const id=idSchema.parse((req.params as any).id); const s=await ownedSession(db,i,id);
    const agents=await db.query('SELECT role,provider,model,session_version,prompt_version,output,elapsed_ms,error_code,created_at FROM agent_runs WHERE session_id=$1 ORDER BY created_at',[id]);
    const jobs=await db.query('SELECT kind,status,attempts,session_version,last_error FROM background_jobs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 10',[id]);
    await audit(db,i.accountId,'followup.read','followup',id);
    return {...s,briefSummary:briefSummary(s.summary),turns:await turnsFor(db,id),agentRuns:agents.rows,jobs:jobs.rows};
  });
  app.post('/api/v1/clinician/followups/:id/review',async req=>{
    const i=requireIdentity(req,'clinician'); const id=idSchema.parse((req.params as any).id);
    const b=z.object({expectedVersion:z.number().int().positive(),feedback:z.string().trim().max(6000),published:z.boolean(),summary:z.record(z.string(),z.unknown()).default({})}).strict().refine(v=>JSON.stringify(v.summary).length<=12000,'审核摘要过长').parse(req.body);
    if(b.published&&!b.feedback) throw conflict('发布前请填写患者可见的反馈');
    return db.transaction(async tx=>{
      const s=await ownedSession(tx,i,id,true); if(!['submitted','handoff'].includes(s.status)||s.version!==b.expectedVersion) throw conflict('随访尚未提交或版本已改变');
      await tx.query('INSERT INTO clinician_reviews(id,session_id,author_id,before_value,after_value) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,i.accountId,{summary:s.clinician_summary,feedback:s.feedback,published:s.feedback_published},{summary:b.summary,feedback:b.feedback,published:b.published}]);
      await tx.query("UPDATE followup_sessions SET clinician_summary=$1,feedback=$2,feedback_published=$3,review_status='reviewed',reviewed_by=$4,reviewed_at=now(),updated_at=now() WHERE id=$5",[b.summary,b.feedback,b.published,i.accountId,id]);
      if(s.task_id) await tx.query("UPDATE followup_tasks SET status='reviewed',updated_at=now() WHERE id=$1",[s.task_id]);
      await audit(tx,i.accountId,'followup.review','followup',id,{published:b.published}); return {ok:true};
    });
  });
  app.get('/api/v1/clinician/protocol',async req=>{requireIdentity(req,'clinician');return {...(await db.query('SELECT version,approved_at,approval_note FROM clinical_protocols WHERE version=$1',[PROTOCOL_VERSION])).rows[0],questions:FIELDS.map(field=>({field,label:LABELS[field],question:QUESTIONS[field]})),endingRule:'五项采集结束、最多十次回答，或患者拒绝继续时结束采集；不确定、未测量与拒绝回答均保留原意。',safetyRule:'识别到预设严重不适描述时停止常规提问，提示主动求助，不宣称已经通知到医生。模板为草案，不能代替急救与临床判断。'};});
  app.post('/api/v1/clinician/protocol/approve',async req=>{
    const i=requireIdentity(req,'clinician'); const {note}=z.object({note:z.string().trim().min(10).max(2000)}).strict().parse(req.body);
    await db.query('UPDATE clinical_protocols SET approved_by=$1,approved_at=now(),approval_note=$2 WHERE version=$3',[i.accountId,note,PROTOCOL_VERSION]);
    await audit(db,i.accountId,'protocol.approve','protocol',undefined,{version:PROTOCOL_VERSION}); return {ok:true};
  });
  return service;
}
