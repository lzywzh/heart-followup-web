import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bindingSchema, idSchema } from '@heart/contracts';
import { AppError, conflict, notFound } from '../errors.js';
import { audit, digest, ownPatient, requireIdentity, type Context } from './context.js';

export async function registerBindings({ app, db }: Context) {
  app.post('/api/v1/clinician/patients/:id/invitations', async (req, reply) => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    return db.transaction(async tx => {
      await tx.query('SELECT id FROM patient_records WHERE id=$1 AND clinician_id=$2 FOR UPDATE', [id, i.accountId]);
      const p = await ownPatient(tx, i, id);
      if (p.account_id) throw conflict('此患者已绑定账户');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
      await tx.query('UPDATE patient_invitations SET revoked_at=now() WHERE patient_id=$1 AND revoked_at IS NULL', [id]);
      await tx.query("UPDATE binding_requests SET status='expired' WHERE patient_id=$1 AND status='pending'", [id]);
      const r = await tx.query("INSERT INTO patient_invitations(id,patient_id,clinician_id,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '48 hours') RETURNING id,expires_at", [randomUUID(), id, i.accountId, digest(code)]);
      await audit(tx, i.accountId, 'invitation.create', 'patient', id);
      reply.code(201); return { id: r.rows[0].id, code, expiresAt: r.rows[0].expires_at };
    });
  });
  app.post('/api/v1/patient/binding', { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const i = requireIdentity(req, 'patient'); const b = bindingSchema.parse(req.body);
    const invalid = () => new AppError(400, 'INVALID_INVITATION', '邀请码无效或暂不可用，请向医生重新获取');
    return db.transaction(async tx => {
      const located = (await tx.query('SELECT patient_id FROM patient_invitations WHERE code_hash=$1', [digest(b.code)])).rows[0];
      if (!located) throw invalid();
      // Use the same patient -> account -> invitation order as direct web provisioning.
      const patientRow = await tx.query('SELECT account_id FROM patient_records WHERE id=$1 FOR UPDATE', [located.patient_id]);
      if (!patientRow.rowCount || patientRow.rows[0].account_id) throw invalid();
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [i.accountId]);
      if ((await tx.query('SELECT id FROM patient_records WHERE account_id=$1', [i.accountId])).rowCount) throw conflict('当前账户已绑定，请联系医生核实');
      const r = await tx.query('SELECT * FROM patient_invitations WHERE code_hash=$1 FOR UPDATE', [digest(b.code)]);
      const inv = r.rows[0]; if (!inv || inv.revoked_at || new Date(inv.expires_at) <= new Date() || (inv.claimed_by && inv.claimed_by !== i.accountId)) throw invalid();
      const existing = await tx.query('SELECT id,status FROM binding_requests WHERE invitation_id=$1 AND account_id=$2', [inv.id, i.accountId]);
      if (existing.rowCount) { if (existing.rows[0].status !== 'pending') throw invalid(); return existing.rows[0]; }
      if ((await tx.query("SELECT id FROM binding_requests WHERE account_id=$1 AND status='pending'", [i.accountId])).rowCount) throw conflict('已有绑定申请待医生确认');
      await tx.query('UPDATE patient_invitations SET claimed_by=$1 WHERE id=$2', [i.accountId, inv.id]);
      const r2 = await tx.query('INSERT INTO binding_requests(id,invitation_id,patient_id,account_id,evidence) VALUES($1,$2,$3,$4,$5) RETURNING id,status', [randomUUID(), inv.id, inv.patient_id, i.accountId, { name: b.name, birthDate: b.birthDate, phone: b.phone }]);
      await audit(tx, i.accountId, 'binding.request', 'patient', inv.patient_id);
      reply.code(201); return r2.rows[0];
    });
  });
  app.get('/api/v1/clinician/bindings', async req => {
    const i = requireIdentity(req, 'clinician');
    const r = await db.query(`SELECT b.id,b.patient_id,b.evidence,b.status,b.created_at,p.name,p.birth_date,p.phone FROM binding_requests b JOIN patient_records p ON p.id=b.patient_id WHERE p.clinician_id=$1 AND b.status='pending' ORDER BY b.created_at`, [i.accountId]);
    return { items: r.rows };
  });
  app.post('/api/v1/clinician/bindings/:id/review', async req => {
    const i = requireIdentity(req, 'clinician'); const id = idSchema.parse((req.params as any).id);
    const b = z.object({ approved: z.boolean(), verificationMethod: z.string().trim().min(2).max(500) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const located = (await tx.query('SELECT patient_id FROM binding_requests WHERE id=$1', [id])).rows[0];
      if (!located) throw notFound();
      const p = (await tx.query('SELECT id FROM patient_records WHERE id=$1 AND clinician_id=$2 FOR UPDATE', [located.patient_id, i.accountId])).rows[0];
      if (!p) throw notFound();
      const r = await tx.query('SELECT b.* FROM binding_requests b WHERE b.id=$1 FOR UPDATE OF b', [id]);
      if (!r.rowCount) throw notFound(); const binding = r.rows[0];
      if (binding.status !== 'pending') throw conflict('此申请已处理');
      const inv = (await tx.query('SELECT * FROM patient_invitations WHERE id=$1', [binding.invitation_id])).rows[0];
      if (inv.revoked_at || new Date(inv.expires_at) <= new Date()) throw conflict('申请已过期，请重新生成邀请');
      if (b.approved) {
        if ((await tx.query('SELECT id FROM patient_records WHERE account_id=$1', [binding.account_id])).rowCount) throw conflict('申请账户已绑定其他档案');
        const bound = await tx.query('UPDATE patient_records SET account_id=$1,updated_at=now() WHERE id=$2 AND account_id IS NULL RETURNING id', [binding.account_id, binding.patient_id]);
        if (!bound.rowCount) throw conflict('此患者已绑定其他账户，请刷新核实');
      }
      await tx.query('UPDATE binding_requests SET status=$1,verification_method=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$4', [b.approved ? 'approved' : 'rejected', b.verificationMethod, i.accountId, id]);
      await tx.query('UPDATE patient_invitations SET revoked_at=now() WHERE id=$1', [binding.invitation_id]);
      await audit(tx, i.accountId, b.approved ? 'binding.approve' : 'binding.reject', 'patient', binding.patient_id, { verificationMethod: b.verificationMethod });
      return { ok: true };
    });
  });
}
