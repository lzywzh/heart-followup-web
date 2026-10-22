import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema, patientCreateSchema, personalSchema, medicalSchema } from '@heart/contracts';
import { conflict } from '../errors.js';
import { audit, ownPatient, requireIdentity, type Context } from './context.js';
import { briefSummary } from '../followups/brief-summary.js';

export function patientView(p: any) {
  return { id: p.id, name: p.name, birthDate: p.birth_date, sex: p.sex, phone: p.phone, emergencyContact: p.emergency_contact, emergencyPhone: p.emergency_phone, personalNotes: p.personal_notes, medicalRecord: p.medical_record, version: p.version, bound: Boolean(p.account_id), createdAt: p.created_at };
}
export async function registerPatients({ app, db }: Context) {
  app.get('/api/v1/patient/me', async req => {
    const i = requireIdentity(req, 'patient');
    const r = await db.query('SELECT * FROM patient_records WHERE account_id=$1', [i.accountId]);
    if (!r.rowCount) {
      const binding = await db.query('SELECT id,status,created_at FROM binding_requests WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1', [i.accountId]);
      return { patient: null, binding: binding.rows[0] || null, tasks: [], history: [], activeSession: null };
    }
    const p = r.rows[0];
    const tasks = await db.query("SELECT *,status NOT IN ('submitted','reviewed','cancelled') AND scheduled_at<now() AS overdue, opens_at<=now() AS available FROM followup_tasks WHERE patient_id=$1 ORDER BY scheduled_at DESC LIMIT 30", [p.id]);
    const history = await db.query("SELECT id,status,started_at,submitted_at,patient_confirmed,summary,CASE WHEN feedback_published THEN feedback END AS feedback FROM followup_sessions WHERE patient_id=$1 AND status IN ('submitted','handoff') ORDER BY started_at DESC LIMIT 30", [p.id]);
    const active = await db.query("SELECT id,status,version FROM followup_sessions WHERE patient_id=$1 AND status IN ('active','paused','awaiting_confirmation')", [p.id]);
    return { patient: patientView(p), binding: null, tasks: tasks.rows, history: history.rows.map(row=>({...row,briefSummary:briefSummary(row.summary)})), activeSession: active.rows[0] || null };
  });
  app.get('/api/v1/clinician/patients', async req => {
    const i = requireIdentity(req, 'clinician');
    const r = await db.query('SELECT * FROM patient_records WHERE clinician_id=$1 ORDER BY created_at DESC', [i.accountId]);
    return { items: r.rows.map(patientView) };
  });
  app.post('/api/v1/clinician/patients', async (req, reply) => {
    const i = requireIdentity(req, 'clinician'); const b = patientCreateSchema.parse(req.body);
    return db.transaction(async tx => {
      const r = await tx.query('INSERT INTO patient_records(id,clinician_id,name,birth_date,sex,phone) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), i.accountId, b.name, b.birthDate, b.sex, b.phone]);
      await audit(tx, i.accountId, 'patient.create', 'patient', r.rows[0].id);
      reply.code(201); return patientView(r.rows[0]);
    });
  });
  app.get('/api/v1/clinician/patients/:id', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const p = await ownPatient(db, i, id);
    await audit(db, i.accountId, 'patient.read', 'patient', id);
    const corrections = await db.query('SELECT id,content,status,resolution,created_at FROM correction_requests WHERE patient_id=$1 ORDER BY created_at DESC', [id]);
    const versions = await db.query('SELECT version,record,created_at FROM medical_record_versions WHERE patient_id=$1 ORDER BY version DESC LIMIT 20', [id]);
    const tasks = await db.query("SELECT *,status NOT IN ('submitted','reviewed','cancelled') AND scheduled_at<now() AS overdue FROM followup_tasks WHERE patient_id=$1 ORDER BY scheduled_at DESC LIMIT 30", [id]);
    const sessions = await db.query('SELECT id,status,priority,review_status,started_at,submitted_at,patient_confirmed FROM followup_sessions WHERE patient_id=$1 ORDER BY started_at DESC LIMIT 30', [id]);
    return { patient: patientView(p), bound: Boolean(p.account_id), corrections: corrections.rows, versions: versions.rows, tasks: tasks.rows, sessions: sessions.rows };
  });
  app.route({method:['PATCH','POST'],url:'/api/v1/patient/me/contact',handler:updateContact});
  app.patch('/api/v1/patient/me',updateContact);
  async function updateContact(req:import('fastify').FastifyRequest) {
    const i = requireIdentity(req, 'patient'); const b = personalSchema.parse(req.body); const p = await ownPatient(db, i);
    const mapping = { phone: 'phone', emergencyContact: 'emergency_contact', emergencyPhone: 'emergency_phone', personalNotes: 'personal_notes' } as const;
    const entries = Object.entries(b).filter(([,v]) => v !== undefined);
    if (entries.length) {
      const columns = entries.map(([key], n) => `${mapping[key as keyof typeof mapping]}=$${n+1}`);
      await db.transaction(async tx => {
        await tx.query(`UPDATE patient_records SET ${columns.join(',')},updated_at=now() WHERE id=$${entries.length+1} AND account_id=$${entries.length+2}`, [...entries.map(([,v]) => v), p.id, i.accountId]);
        await audit(tx, i.accountId, 'patient.contact.update', 'patient', p.id, { fields: entries.map(([key]) => key) });
      });
    }
    return { ok: true };
  }
  app.put('/api/v1/clinician/patients/:id/medical-record', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const b = z.object({ expectedVersion: z.number().int().positive(), record: medicalSchema }).strict().parse(req.body);
    return db.transaction(async tx => {
      await ownPatient(tx, i, id);
      const r = await tx.query('UPDATE patient_records SET medical_record=$1,version=version+1,updated_at=now() WHERE id=$2 AND clinician_id=$3 AND version=$4 RETURNING *', [b.record, id, i.accountId, b.expectedVersion]);
      if (!r.rowCount) throw conflict();
      await tx.query('INSERT INTO medical_record_versions(id,patient_id,author_id,record,version) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, i.accountId, b.record, r.rows[0].version]);
      await audit(tx, i.accountId, 'patient.medical.update', 'patient', id, { version: r.rows[0].version });
      return patientView(r.rows[0]);
    });
  });
  app.post('/api/v1/patient/me/corrections', async (req, reply) => {
    const i = requireIdentity(req, 'patient'); const p = await ownPatient(db, i);
    const b = z.object({ content: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const id = randomUUID();
    await db.query('INSERT INTO correction_requests(id,patient_id,account_id,content) VALUES($1,$2,$3,$4)', [id, p.id, i.accountId, b.content]);
    reply.code(201); return { id, status: 'pending' };
  });
  app.post('/api/v1/clinician/patients/:id/corrections/:requestId/resolve', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id); const requestId = idSchema.parse((req.params as any).requestId);
    const b = z.object({ resolution: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    await ownPatient(db, i, id);
    const r = await db.query("UPDATE correction_requests SET status='resolved',resolution=$1,resolved_at=now() WHERE id=$2 AND patient_id=$3 RETURNING id", [b.resolution, requestId, id]);
    if (!r.rowCount) throw conflict('更正申请不存在');
    await audit(db, i.accountId, 'correction.resolve', 'patient', id); return { ok: true };
  });
}
