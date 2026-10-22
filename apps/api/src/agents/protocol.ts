export const PROTOCOL_VERSION = 'heart-failure-draft-v1';
export const FIELDS = ['breathing','swelling','weight','medication','concerns'] as const;
export type Field = typeof FIELDS[number];
export const LABELS: Record<Field,string> = { breathing:'呼吸与活动', swelling:'下肢肿胀', weight:'近期体重', medication:'按医嘱用药情况', concerns:'其他想补充的情况' };
export const QUESTIONS: Record<Field,string> = {
  breathing:'最近活动或休息时，呼吸感觉怎么样？', swelling:'最近脚踝或小腿有没有肿，和之前比有什么变化？',
  weight:'最近量过体重吗？大约是多少，是什么时候量的？', medication:'最近能按原来的医嘱用药吗，有没有遇到困难？', concerns:'还有什么身体情况或问题想让医生了解吗？',
};
export const GREETING = '您好，我是随访助手。我们先聊聊您最近的身体情况。' + QUESTIONS.breathing;
export type FactStatus = 'reported' | 'unknown' | 'declined';
export interface Fact { field: Field; value: string; evidence: string; status: FactStatus; turnId?: string; }
export interface CollectionState { fields: Partial<Record<Field,Fact>>; attempts: Partial<Record<Field,number>>; nextField: Field | null; answerCount: number; }
export const initialState = (): CollectionState => ({ fields:{}, attempts:{}, nextField:'breathing', answerCount:0 });

export function safetySignal(text: string) {
  const clauses = text.split(/[，。！？；,;\n]/);
  return clauses.find(part => /喘得(?:无法|不能|说不出)(?:完整)?(?:的)?(?:话|句子)|呼吸困难.{0,8}说不出|突然.{0,5}意识(?:不清|异常)|(?:现在|刚刚).{0,4}意识不清/.test(part)
    && !/(?:没有|并非|不是|否认|未曾).{0,8}(?:喘得|呼吸困难|意识)/.test(part)) || null;
}
export const refusing = (text: string) => /(?:不想|不愿|拒绝).{0,6}(?:继续|随访)|(?:停止|结束).{0,4}随访/.test(text);
export const unsure = (text: string) => /不知道|不清楚|没(?:有)?(?:量|测)|记不清|不确定/.test(text);
export const declines = (text: string) => /不想回答|不愿回答|不方便说|跳过/.test(text);

export function validateFacts(candidate: unknown, text: string, turnId: string): Fact[] {
  if (!Array.isArray(candidate)) return [];
  const facts = new Map<Field,Fact>();
  for (const raw of candidate.slice(0,10)) {
    if (!raw || !FIELDS.includes(raw.field) || typeof raw.evidence !== 'string' || !raw.evidence.trim() || !text.includes(raw.evidence) || raw.evidence.length>1000) continue;
    const status = raw.status === 'declined' && declines(raw.evidence) ? 'declined' : raw.status === 'unknown' ? 'unknown' : 'reported';
    // Keep the patient's actual words; never silently normalize a model-invented value.
    facts.set(raw.field, { field:raw.field, value:raw.evidence, evidence:raw.evidence, status, turnId });
  }
  return [...facts.values()];
}
export function rebuildState(turns: any[]): CollectionState {
  const state = initialState();
  const superseded = new Set(turns.filter(t => t.supersedes_id).map(t => t.supersedes_id));
  for (const turn of turns) if (turn.status === 'completed' && !superseded.has(turn.id)) {
    for (const fact of turn.evidence || []) if (FIELDS.includes(fact.field)) state.fields[fact.field as Field] = fact;
  }
  state.answerCount = turns.filter(t => t.source !== 'correction' && t.status === 'completed').length;
  state.nextField = FIELDS.find(f => !state.fields[f]) || null;
  return state;
}
export function collectionSummary(state: CollectionState) {
  return { complete: FIELDS.every(f => state.fields[f]?.status === 'reported'), items: FIELDS.map(field => ({ ...(state.fields[field] || { value:'尚未采集', evidence:'', status:'missing' }), field, label:LABELS[field] })) };
}
