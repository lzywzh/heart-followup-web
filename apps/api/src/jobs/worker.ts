import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { buildReview } from '../agents/review.js';
import { turnsFor } from '../followups/service.js';

export async function processNextJob({db,config,providers}: {db:Database;config:AppConfig;providers:Record<string,any>}) {
  const job=await db.transaction(async tx=>{
    const r=await tx.query("SELECT * FROM background_jobs WHERE (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
    if(!r.rowCount) return null;
    return (await tx.query("UPDATE background_jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '60 seconds',attempt_token=$2 WHERE id=$1 RETURNING *",[r.rows[0].id,randomUUID()])).rows[0];
  });
  if(!job) return false;
  const session=(await db.query('SELECT * FROM followup_sessions WHERE id=$1',[job.session_id])).rows[0];
  if(!session||session.version!==job.session_version) {await db.query("UPDATE background_jobs SET status='stale',lease_until=NULL WHERE id=$1 AND attempt_token=$2 AND status='running'",[job.id,job.attempt_token]);return true;}
  const started=Date.now();
  try {
    const runs=await buildReview(config,session,await turnsFor(db,session.id),providers);
    await db.transaction(async tx=>{
      const current=(await tx.query('SELECT version FROM followup_sessions WHERE id=$1 FOR UPDATE',[session.id])).rows[0];
      const attempt=(await tx.query('SELECT status,attempt_token FROM background_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(attempt?.status!=='running'||attempt.attempt_token!==job.attempt_token)return;
      if(current.version!==job.session_version) {await tx.query("UPDATE background_jobs SET status='stale',lease_until=NULL WHERE id=$1",[job.id]);return;}
      for(const run of runs) await tx.query('INSERT INTO agent_runs(id,session_id,session_version,role,provider,model,output,elapsed_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),session.id,job.session_version,run.role,run.provider,run.model,run.output,Date.now()-started]);
      await tx.query('UPDATE followup_sessions SET ai_review=$1 WHERE id=$2',[{version:job.session_version,runs:runs.map((r:any)=>({role:r.role,output:r.output,provider:r.provider})),completedAt:new Date().toISOString()},session.id]);
      await tx.query("UPDATE background_jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE id=$1",[job.id]);
    });
  } catch {
    await db.query("UPDATE background_jobs SET status=$1,lease_until=NULL,last_error='REVIEW_SERVICE_UNAVAILABLE',available_at=now()+interval '30 seconds' WHERE id=$2 AND attempt_token=$3 AND status='running'",[job.attempts>=3?'failed':'pending',job.id,job.attempt_token]);
  }
  return true;
}

export function startWorker(options:Parameters<typeof processNextJob>[0]) {
  let stopped=false;let busy=false;
  const timer=setInterval(async()=>{if(stopped||busy)return;busy=true;try{await processNextJob(options);}catch{}finally{busy=false;}},2000);
  timer.unref();
  return async()=>{stopped=true;clearInterval(timer);while(busy)await new Promise(resolve=>setTimeout(resolve,50));};
}
