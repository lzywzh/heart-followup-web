import { z } from 'zod';

export const idSchema = z.uuid();
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1900-01-01' && d <= new Date();
}, '请输入有效出生日期');
export const textField = (max = 2000) => z.string().trim().max(max);
export const phoneSchema = z.string().trim().max(32).regex(/^[+\d\s()-]*$/, '请输入有效联系电话');
export const patientCreateSchema = z.object({ name: z.string().trim().min(1).max(80), birthDate: dateSchema, sex: z.enum(['male','female','unspecified']).default('unspecified'), phone: phoneSchema.default('') }).strict();
export const personalSchema = z.object({ phone: phoneSchema.optional(), emergencyContact: textField(80).optional(), emergencyPhone: phoneSchema.optional(), personalNotes: textField().optional() }).strict();
export const medicalSchema = z.object({ diagnosis: textField(4000).default(''), history: textField(6000).default(''), dischargeSummary: textField(6000).default(''), carePlan: textField(4000).default(''), medications: textField(4000).default('') }).strict();
export const bindingSchema = z.object({ code: z.string().trim().regex(/^[A-HJ-NP-Z2-9]{12}$/), name: z.string().trim().min(1).max(80), birthDate: dateSchema, phone: phoneSchema.min(5) }).strict();
export const taskSchema = z.object({ patientId: idSchema, title: z.string().trim().min(1).max(120).default('心衰随访'), scheduledAt: z.iso.datetime({ offset: true }) }).strict();
export const messageSchema = z.object({ clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), text: z.string().trim().min(1).max(1000), source: z.enum(['text','voice']).default('text'), expectedVersion: z.number().int().positive() }).strict();
export const correctionSchema = z.object({ clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), turnId: idSchema, text: z.string().trim().min(1).max(1000), expectedVersion: z.number().int().positive() }).strict();
export type PatientCreate = z.infer<typeof patientCreateSchema>;
export type MedicalRecord = z.infer<typeof medicalSchema>;
export type Role = 'admin' | 'clinician' | 'patient';
export interface Identity { accountId: string; role: Role; sessionId: string; kind: 'web' | 'patient'; csrfToken: string | null; displayName: string; }
