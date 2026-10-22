import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema, taskSchema } from '@heart/contracts';
import { conflict, notFound } from '../errors.js';
import { audit, ownPatient, requireIdentity, type Context } from './context.js';

export async function registerTasks({ app, db }: Context) {
  app.get('/api/v1/clinician/tasks', async req => {
    const i = requireIdentity(req, 'clinician');
    const r = await db.query("SELECT t.*,p.name, t.status NOT IN ('submitted','reviewed','cancelled') AND t.scheduled_at<now() AS overdue FROM followup_tasks t JOIN patient_records p ON p.id=t.patient_id WHERE t.clinician_id=$1 ORDER BY t.scheduled_at DESC LIMIT 300", [i.accountId]);
    return { items: r.rows };
  });
  app.post('/api/v1/clinician/tasks', async (req, reply) => {
    const i = requireIdentity(req, 'clinician'); const b = taskSchema.parse(req.body);
    return db.transaction(async tx => {
      await ownPatient(tx, i, b.patientId);
      const r = await tx.query("INSERT INTO followup_tasks(id,patient_id,clinician_id,title,scheduled_at,opens_at) VALUES($1,$2,$3,$4,$5,$5::timestamptz-interval '24 hours') RETURNING *", [randomUUID(), b.patientId, i.accountId, b.title, b.scheduledAt]);
      await audit(tx, i.accountId, 'task.create', 'task', r.rows[0].id);
      reply.code(201); return r.rows[0];
    });
  });
  app.patch('/api/v1/clinician/tasks/:id', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const b = z.object({ scheduledAt: z.iso.datetime({ offset: true }).optional(), cancelled: z.boolean().optional() }).strict().refine(v => Boolean(v.scheduledAt) !== Boolean(v.cancelled), '请选择改期或取消').parse(req.body);
    return db.transaction(async tx => {
      const r = await tx.query('SELECT * FROM followup_tasks WHERE id=$1 AND clinician_id=$2 FOR UPDATE', [id, i.accountId]);
      if (!r.rowCount) throw notFound(); if (r.rows[0].status !== 'pending') throw conflict('此任务已开始或结束，不能直接改期或取消');
      if (b.cancelled) await tx.query("UPDATE followup_tasks SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
      else await tx.query("UPDATE followup_tasks SET scheduled_at=$1,opens_at=$1::timestamptz-interval '24 hours',updated_at=now() WHERE id=$2", [b.scheduledAt, id]);
      await audit(tx, i.accountId, b.cancelled ? 'task.cancel' : 'task.reschedule', 'task', id, { previous: r.rows[0].scheduled_at, scheduledAt: b.scheduledAt });
      return { ok: true };
    });
  });
}
