import { FIELDS, LABELS } from '../agents/protocol.js';

export interface BriefSummary {
  title: string;
  items: { label: string; value: string }[];
  note: string;
}

/** Keep the patient and physician summary tied to the same saved collection snapshot. */
export function briefSummary(summary: unknown): BriefSummary {
  const source = summary && typeof summary === 'object' && Array.isArray((summary as any).items) ? (summary as any).items : [];
  return {
    title: '本次随访小结',
    items: FIELDS.map(field => {
      const item = source.find((entry: any) => entry?.field === field);
      const raw = item && item.status !== 'missing' && typeof item.value === 'string' ? item.value.trim() : '';
      return { label: LABELS[field], value: raw ? (raw.length > 120 ? raw.slice(0, 120) + '…' : raw) : '本次未采集' };
    }),
    note: '根据本次交流整理，等待医生核对。未采集或不确定的内容不代表正常。',
  };
}
