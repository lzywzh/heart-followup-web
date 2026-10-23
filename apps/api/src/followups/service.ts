import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Identity } from '@heart/contracts';
import { AppError, conflict, notFound } from '../errors.js';
import { assertActiveSession, audit, ownPatient } from '../modules/context.js';
import { briefSummary } from './brief-summary.js';
import { collectionSummary, GREETING, initialState, rebuildState, PROTOCOL_VERSION } from '../agents/protocol.js';
import { runDialogue } from '../agents/dialogue.js';

export async function ownedSession(db: Database, identity: Identity, id: string, lock = false) {
  const r = await db.query(`SELECT s.* FROM followup_sessions s JOIN patient_records p ON p.id=s.patient_id WHERE s.id=$1 AND ${identity.role === 'patient' ? 'p.account_id' : 'p.clinician_id'}=$2${lock ? ' FOR UPDATE OF s' : ''}`, [id, identity.accountId]);
  if (!r.rowCount) throw notFound(); return r.rows[0];
}
export async function turnsFor(db: Database, id: string) { return (await db.query('SELECT * FROM followup_turns WHERE session_id=$1 ORDER BY sequence',[id])).rows; }
function dialogueHistory(turns:any[],replacedId?:string){
  const superseded=new Set(turns.filter(t=>t.status==='completed'&&t.supersedes_id).map(t=>t.supersedes_id));
  if(replacedId)superseded.add(replacedId);
  return turns.filter(t=>t.status==='completed'&&!superseded.has(t.id)).slice(-12).map(t=>({patientText:t.patient_text,assistantText:t.assistant_text}));
}
export async function patientSessionView(db: Database, session: any) {
  const turns = await turnsFor(db,session.id); const superseded = new Set(turns.filter(t=>t.status==='completed'&&t.supersedes_id).map(t=>t.supersedes_id));
  const summary = session.summary || collectionSummary(session.state?.fields ? session.state : initialState());
  const operations = await db.query('SELECT client_message_id,status,expected_version,transcript,lease_until FROM browser_audio_requests WHERE session_id=$1 ORDER BY created_at',[session.id]);
  return { id:session.id, taskId:session.task_id, status:session.status, version:session.version, greeting:GREETING,conversationPhase:session.state?.phase||'collection',
    protocolVersion:session.protocol_version, patientConfirmed:session.patient_confirmed, requiresHumanReview:session.priority!=='routine',
    summary, briefSummary:briefSummary(summary),
    audioOperations:operations.rows.map(op=>({clientMessageId:op.client_message_id,status:op.status==='processing'&&new Date(op.lease_until)<=new Date()?'stale':op.status,expectedVersion:op.expected_version,transcript:op.transcript||undefined,leaseUntil:op.lease_until,retryable:op.status==='failed'||(op.status==='processing'&&new Date(op.lease_until)<=new Date())})),
    feedback:session.feedback_published ? session.feedback : null, reviewStatus:session.review_status,
    turns:turns.map(t=>({id:t.id,clientMessageId:t.client_message_id,sequence:t.sequence,patientText:t.patient_text,assistantText:t.assistant_text,status:t.status==='pending'&&new Date(t.lease_until)<=new Date()?'failed':t.status,source:t.source,supersedesId:t.supersedes_id,superseded:superseded.has(t.id),createdAt:t.created_at})),
  };
}

export function createFollowupService({db,config,providers}: {db:Database;config:AppConfig;providers:Record<string,any>}) {
  const guard = (tx:Database,identity:Identity,lock=true) => assertActiveSession(tx,identity,lock,config.nodeEnv==='production');
  const view = async (identity:Identity,id:string) => {await guard(db,identity,false);return patientSessionView(db,await ownedSession(db,identity,id));};
  async function audioFence(tx:Database,id:string,claim?:{id:string;token:string}) {
    if(claim){
      const row=(await tx.query('SELECT status,attempt_token,lease_until FROM browser_audio_requests WHERE id=$1 AND session_id=$2 FOR UPDATE',[claim.id,id])).rows[0];
      if(row?.status!=='processing'||row.attempt_token!==claim.token||new Date(row.lease_until)<=new Date())throw conflict('这段录音已由新的处理接管，请刷新查看');
    }else if((await tx.query("SELECT id FROM browser_audio_requests WHERE session_id=$1 AND status='processing' AND lease_until>now()",[id])).rowCount){
      throw new AppError(409,'VOICE_PROCESSING','这句话仍在处理，请稍等');
    }
  }
  async function start(identity:Identity, input:{clientRequestId:string;taskId?:string}) {
    return db.transaction(async tx => {
      const p = await ownPatient(tx,identity);
      await tx.query('SELECT id FROM patient_records WHERE id=$1 FOR UPDATE',[p.id]);
      await guard(tx,identity);
      const previous = await tx.query('SELECT * FROM followup_sessions WHERE patient_id=$1 AND start_key=$2',[p.id,input.clientRequestId]);
      if (previous.rowCount) return { created:false, session:await patientSessionView(tx,previous.rows[0]) };
      const active = await tx.query("SELECT * FROM followup_sessions WHERE patient_id=$1 AND status IN ('active','paused','awaiting_confirmation')",[p.id]);
      if (active.rowCount) {
        if ((active.rows[0].task_id||null)!==(input.taskId||null)) throw conflict('还有一份随访未完成，请先继续原随访');
        return {created:false,session:await patientSessionView(tx,active.rows[0])};
      }
      const protocol = (await tx.query('SELECT * FROM clinical_protocols WHERE version=$1',[PROTOCOL_VERSION])).rows[0];
      if (config.nodeEnv==='production' && !protocol?.approved_at && !config.protocolApproved) throw new AppError(409,'PROTOCOL_NOT_APPROVED','随访采集模板尚未由合作医生确认，暂不能开始');
      if (input.taskId) {
        const task = (await tx.query('SELECT * FROM followup_tasks WHERE id=$1 AND patient_id=$2 FOR UPDATE',[input.taskId,p.id])).rows[0];
        if (!task) throw notFound();
        if (!['pending','in_progress'].includes(task.status) || new Date(task.opens_at)>new Date()) throw conflict('这次随访尚未开放或已经结束');
        if ((await tx.query('SELECT id FROM followup_sessions WHERE task_id=$1',[input.taskId])).rowCount) throw conflict('这项任务已有关联随访');
        await tx.query("UPDATE followup_tasks SET status='in_progress',updated_at=now() WHERE id=$1",[input.taskId]);
      }
      const r=await tx.query('INSERT INTO followup_sessions(id,patient_id,clinician_id,task_id,start_key,state,protocol_approved) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [randomUUID(),p.id,p.clinician_id,input.taskId||null,input.clientRequestId,initialState(),Boolean(protocol?.approved_at)||config.protocolApproved]);
      await audit(tx,identity.accountId,'followup.start','followup',r.rows[0].id);
      return {created:true,session:await patientSessionView(tx,r.rows[0])};
    });
  }

  async function message(identity:Identity,id:string,input:{clientMessageId:string;text:string;expectedVersion:number;source?:'text'|'voice';turnId?:string;audioRequest?:{id:string;token:string}}) {
    const claim = await db.transaction(async tx => {
      await guard(tx,identity);
      const s=await ownedSession(tx,identity,id,true);
      await audioFence(tx,id,input.audioRequest);
      const existing=(await tx.query('SELECT * FROM followup_turns WHERE session_id=$1 AND client_message_id=$2',[id,input.clientMessageId])).rows[0];
      if (existing) {
        if (existing.patient_text!==input.text || (existing.supersedes_id||null)!==(input.turnId||null)) throw conflict('该消息编号已经用于其他内容');
        if (existing.status==='completed') return {cached:true as const};
        if (existing.status==='pending' && new Date(existing.lease_until)>new Date()) throw conflict('上一句还在处理中，请稍等');
        if (!['active','awaiting_confirmation'].includes(s.status) || s.version!==existing.session_version) throw conflict('请刷新会话后重新确认这句话');
        const attemptToken=randomUUID();
        await tx.query("UPDATE followup_turns SET status='pending',lease_until=now()+interval '60 seconds',attempt_token=$2 WHERE id=$1",[existing.id,attemptToken]);
        const all=await turnsFor(tx,id); const state=input.turnId?rebuildState(all):s.state;
        return {cached:false as const, turnId:existing.id,version:s.version,state,patientId:s.patient_id,attemptToken,history:dialogueHistory(all,input.turnId)};
      }
      if (!['active','awaiting_confirmation'].includes(s.status)) throw conflict('随访已暂停或结束，请先查看当前状态');
      if (s.version!==input.expectedVersion) throw conflict();
      const pending=await tx.query("SELECT id FROM followup_turns WHERE session_id=$1 AND status='pending' AND lease_until>now()",[id]);
      if (pending.rowCount) throw conflict('上一句还在处理中，请稍等');
      await tx.query("UPDATE followup_turns SET status='failed' WHERE session_id=$1 AND status='pending' AND lease_until<=now()",[id]);
      const all=await turnsFor(tx,id);
      if (input.turnId) {
        if (!all.some(t=>t.id===input.turnId&&t.status==='completed') || all.some(t=>t.supersedes_id===input.turnId&&t.status==='completed')) throw conflict('请更正最新有效的回答');
      }
      const turnId=randomUUID(); const version=s.version+1;const attemptToken=randomUUID();
      await tx.query('INSERT INTO followup_turns(id,session_id,client_message_id,sequence,patient_text,source,supersedes_id,session_version,lease_until,attempt_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval \'60 seconds\',$9)',
        [turnId,id,input.clientMessageId,all.length+1,input.text,input.turnId?'correction':input.source||'text',input.turnId||null,version,attemptToken]);
      await tx.query('UPDATE followup_sessions SET version=$1,updated_at=now() WHERE id=$2',[version,id]);
      const state=input.turnId?rebuildState([...all,{status:'pending',supersedes_id:input.turnId}]):s.state;
      return {cached:false as const,turnId,version,state,patientId:s.patient_id,attemptToken,history:dialogueHistory(all,input.turnId)};
    });
    if (claim.cached) return view(identity,id);
    const p=await ownPatient(db,identity,claim.patientId);
    const outcome=await runDialogue({config,providers,text:input.text,state:claim.state,patient:p,turnId:claim.turnId,isCorrection:Boolean(input.turnId),history:claim.history});
    return db.transaction(async tx => {
      await guard(tx,identity);
      const s=await ownedSession(tx,identity,id,true);
      await audioFence(tx,id,input.audioRequest);
      if (s.version!==claim.version || !['active','paused','awaiting_confirmation'].includes(s.status)) throw conflict('会话已改变，迟到的回复未加入当前记录');
      const attempt=(await tx.query('SELECT status,attempt_token FROM followup_turns WHERE id=$1 FOR UPDATE',[claim.turnId])).rows[0];
      if(attempt?.status!=='pending'||attempt.attempt_token!==claim.attemptToken)throw conflict('该回答已由新的处理接管，旧回复已丢弃');
      await tx.query("UPDATE followup_turns SET status='completed',assistant_text=$1,evidence=$2,timing=$3,lease_until=NULL WHERE id=$4",[outcome.reply,JSON.stringify(outcome.facts),{agentMs:outcome.elapsedMs},claim.turnId]);
      const status=outcome.endRequested?'submitted':outcome.handoff?'handoff':s.status==='paused'?'paused':outcome.done?'awaiting_confirmation':'active';
      await tx.query(`UPDATE followup_sessions SET state=$1,summary=$2,status=$3,priority=CASE WHEN priority='urgent' THEN priority ELSE $4 END,review_status=CASE WHEN $5 THEN 'pending' ELSE review_status END,updated_at=now() WHERE id=$6`,
        [outcome.state,collectionSummary(outcome.state),status,outcome.priority,outcome.handoff,id]);
      await tx.query('INSERT INTO agent_runs(id,session_id,turn_id,session_version,role,provider,model,output,elapsed_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(),id,claim.turnId,claim.version,outcome.priority==='urgent'?'safety':'dialogue',outcome.provider,outcome.model,{facts:outcome.facts,action:outcome.action,focusField:outcome.focusField,phase:outcome.state.phase,reason:outcome.reason},outcome.elapsedMs]);
      await tx.query("INSERT INTO background_jobs(id,kind,session_id,session_version) VALUES($1,'review',$2,$3) ON CONFLICT DO NOTHING",[randomUUID(),id,claim.version]);
      if(outcome.endRequested){
        await tx.query("UPDATE followup_sessions SET patient_confirmed=false,submission_version=version,submitted_at=COALESCE(submitted_at,now()),review_status='pending' WHERE id=$1",[id]);
        if(s.task_id)await tx.query("UPDATE followup_tasks SET status='submitted',updated_at=now() WHERE id=$1",[s.task_id]);
        await audit(tx,identity.accountId,'followup.submit','followup',id,{confirmed:false,reason:'patient_finished',version:claim.version});
      }
      if (outcome.handoff) {
        await audit(tx,identity.accountId,'followup.handoff','followup',id,{reason:outcome.reason});
        if (s.task_id) await tx.query("UPDATE followup_tasks SET status='submitted',updated_at=now() WHERE id=$1",[s.task_id]);
      }
      return patientSessionView(tx,(await tx.query('SELECT * FROM followup_sessions WHERE id=$1',[id])).rows[0]);
    });
  }

  async function pause(identity:Identity,id:string,resume=false) {
    return db.transaction(async tx=>{
      await guard(tx,identity);
      const s=await ownedSession(tx,identity,id,true);
      if (['submitted','handoff','cancelled'].includes(s.status)) return patientSessionView(tx,s);
      const status=resume?(s.state?.phase==='closing'?'awaiting_confirmation':'active'):'paused';
      const r=await tx.query('UPDATE followup_sessions SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,id]);
      return patientSessionView(tx,r.rows[0]);
    });
  }
  async function submit(identity:Identity,id:string,input:{expectedVersion:number;confirmed:boolean}) {
    return db.transaction(async tx=>{
      await guard(tx,identity);
      const s=await ownedSession(tx,identity,id,true);
      if (s.status==='submitted') return patientSessionView(tx,s);
      if((await tx.query("SELECT id FROM browser_audio_requests WHERE session_id=$1 AND status='processing' AND lease_until>now()",[id])).rowCount)throw new AppError(409,'VOICE_PROCESSING','这句话仍在处理，处理完成后才能结束通话');
      await tx.query("UPDATE browser_audio_requests SET status='failed',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND status='processing' AND lease_until<=now()",[id]);
      if (s.version!==input.expectedVersion) throw conflict();
      await tx.query("UPDATE followup_turns SET status='failed',lease_until=NULL,attempt_token=NULL WHERE session_id=$1 AND status='pending' AND lease_until<=now()",[id]);
      if ((await tx.query("SELECT id FROM followup_turns WHERE session_id=$1 AND status='pending'",[id])).rowCount) throw conflict('上一句话尚未处理完成，请重试或等待后再提交');
      if (!['active','paused','awaiting_confirmation','handoff'].includes(s.status)) throw conflict('这次随访不能提交');
      if(!(await tx.query("SELECT id FROM followup_turns WHERE session_id=$1 AND status IN ('completed','failed') AND length(trim(patient_text))>0",[id])).rowCount)throw new AppError(409,'EMPTY_CALL','还没有采集到您的回答，请先完成语音交流');
      const summary=collectionSummary(s.state?.fields?s.state:initialState());
      const r=await tx.query("UPDATE followup_sessions SET status='submitted',summary=$1,patient_confirmed=$2,submission_version=version,submitted_at=COALESCE(submitted_at,now()),review_status='pending',updated_at=now() WHERE id=$3 RETURNING *",[summary,input.confirmed,id]);
      if (s.task_id) await tx.query("UPDATE followup_tasks SET status='submitted',updated_at=now() WHERE id=$1",[s.task_id]);
      await tx.query("INSERT INTO background_jobs(id,kind,session_id,session_version) VALUES($1,'review',$2,$3) ON CONFLICT DO NOTHING",[randomUUID(),id,s.version]);
      await audit(tx,identity.accountId,'followup.submit','followup',id,{confirmed:input.confirmed,complete:summary.complete,version:s.version});
      return patientSessionView(tx,r.rows[0]);
    });
  }
  return {start,message,pause,submit,view};
}
