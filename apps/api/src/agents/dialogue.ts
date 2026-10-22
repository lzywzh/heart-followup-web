import type { AppConfig } from '../config.js';
import { extractFacts } from './providers.js';
import { QUESTIONS, FIELDS, initialState, validateFacts, safetySignal, refusing, unsure, declines, type CollectionState, type Fact, type Field } from './protocol.js';

const clarifications:Record<Field,string>={
  breathing:'比如平地走路、上楼，或者躺下休息时，有没有觉得气不够用？',
  swelling:'最近脚踝或小腿有没有肿，鞋袜有没有比平时更紧？',
  weight:'如果最近有称过，告诉我大概多少公斤；没称过也可以直接说。',
  medication:'这几天有没有漏服，或者遇到拿药、按时服药方面的困难？',
  concerns:'您可以说说最在意的一件事；暂时没有想补充的，也可以告诉我。',
};
function spokenReply(state:CollectionState,target:Field,facts:Fact[],done:boolean,isCorrection:boolean){
  if(done)return '这次先聊到这里。您说的情况已经记下，点“结束通话”就能看到本次小结，之后由医生审核。';
  if(!facts.length&&state.nextField===target)return '我想再了解具体一点。'+clarifications[target];
  const current=facts.find(f=>f.field===target);
  const bridge=isCorrection?'好的，更正的内容已经记下。':current?.status==='declined'?'好的，这一项先跳过。':current?.status==='unknown'?(target==='weight'&&/没(?:有)?(?:量|测)|没称/.test(current.evidence)?'没量也没关系，这一项先不填具体数值。':'不确定也没关系，这一项先留给医生核实。'):facts.length>1?'您刚才提到的几个方面都记下了。':({breathing:'嗯，了解了。',swelling:'好，我们接着聊。',weight:'好的。',medication:'用药这方面也了解了。',concerns:'谢谢您告诉我。'}[target]);
  return bridge+QUESTIONS[state.nextField!];
}

export async function runDialogue({config,providers,text,state,patient,turnId,isCorrection}: {config:AppConfig;providers:Record<string,any>;text:string;state:CollectionState;patient:any;turnId:string;isCorrection:boolean}) {
  const started = Date.now(); const next: CollectionState = structuredClone(state || initialState());
  const target = next.nextField || 'concerns';
  if (!isCorrection) next.answerCount++;
  const signal = safetySignal(text);
  if (signal || refusing(text)) return { state:next, facts:[] as Fact[], reply: signal ? '您的描述需要及时由专业人员处理。请尽快联系当地急救服务或身边的人协助就医，不要等待本次随访。记录已进入待处理队列。' : '好的，我们停止本次随访。已记录的信息会交给医生查看。', handoff:true, priority:signal?'urgent':'attention', provider:'rules', model:'none', elapsedMs:Date.now()-started, reason:signal?'urgent_description':'patient_refusal' };
  let extraction: any;
  try { extraction = await extractFacts(config,{text,state:next,patient},providers); }
  catch { return { state:next, facts:[] as Fact[], reply:'已记录您的描述。目前无法可靠地继续分析，记录已进入待人工处理队列，请联系负责医生。', handoff:true, priority:'attention', provider:'unavailable', model:config.deepseekModel, elapsedMs:Date.now()-started, reason:'model_unavailable' }; }
  const facts = validateFacts(extraction.facts,text,turnId);
  if (!facts.length && (unsure(text)||declines(text))) facts.push({field:target,value:text,evidence:text,status:declines(text)?'declined':'unknown',turnId});
  for (const fact of facts) next.fields[fact.field] = fact;
  if (!next.fields[target]) {
    next.attempts[target] = (next.attempts[target] || 0) + 1;
    if (next.attempts[target]! >= 2) { const f:Fact = {field:target,value:'待医生进一步核实',evidence:text,status:'unknown',turnId}; facts.push(f); next.fields[target]=f; }
  }
  next.nextField = FIELDS.find(f => !next.fields[f]) || null;
  const done = !next.nextField || next.answerCount>=10;
  return { state:next, facts, reply:spokenReply(next,target,facts,done,isCorrection), handoff:false, priority:'routine', done, provider:extraction.provider || 'custom', model:extraction.model || config.deepseekModel, elapsedMs:Date.now()-started, reason:'collection' };
}
