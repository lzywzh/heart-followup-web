import type { AppConfig } from '../config.js';
import { planDialogueTurn } from './providers.js';
import { QUESTIONS, FIELDS, initialState, validateFacts, safetySignal, unsure, declines, coreCollected, rememberFact, type CollectionState, type Fact, type Field, type DialogueHistoryTurn } from './protocol.js';
import {CLOSING_INVITATION, patientFinishIntent, closingOnly, safeSpokenReply} from './conversation.js';

const clarifications:Record<Field,string>={
  breathing:'比如平地走路、上楼，或者躺下休息时，有没有觉得气不够用？',
  swelling:'最近脚踝或小腿有没有肿，鞋袜有没有比平时更紧？',
  weight:'如果最近有称过，告诉我大概多少公斤；没称过也可以直接说。',
  medication:'这几天有没有漏服，或者遇到拿药、按时服药方面的困难？',
  concerns:'您可以继续说说最在意的情况，或者问我问题。',
};
function fallbackReply(state:CollectionState,target:Field,facts:Fact[],isCorrection:boolean){
  if(!facts.length&&state.nextField===target)return '我想再了解具体一点。'+clarifications[target];
  const current=facts.find(f=>f.field===target);
  const bridge=isCorrection?'好的，更正的内容已经记下。':current?.status==='declined'?'好的，这一项先跳过。':current?.status==='unknown'?(target==='weight'?'没量也没关系，这一项先不填具体数值。':'不确定也没关系，先留给医生核实。'):'好的，我记下了。';
  return bridge+(state.nextField?QUESTIONS[state.nextField]:CLOSING_INVITATION);
}

export async function runDialogue({config,providers,text,state,patient,turnId,isCorrection,history=[]}: {config:AppConfig;providers:Record<string,any>;text:string;state:CollectionState;patient:any;turnId:string;isCorrection:boolean;history?:DialogueHistoryTurn[]}) {
  const started=Date.now();const next:CollectionState=structuredClone(state||initialState());
  const target=next.focusField||next.nextField||'concerns';
  const endRequested=!isCorrection&&patientFinishIntent(text,next);
  if(!isCorrection)next.answerCount++;
  next.urgent=Boolean(next.urgent||safetySignal(text));
  let extraction:any;let unavailable=false;
  try{extraction=await planDialogueTurn(config,{text,state:next,patient,history},providers);}
  catch{unavailable=true;extraction={facts:[],provider:'unavailable',model:config.deepseekModel};}
  const facts=validateFacts(extraction.facts,text,turnId).filter(f=>!closingOnly(f.evidence));
  if(!facts.length&&!closingOnly(text)&&(unsure(text)||declines(text)))facts.push({field:target,value:text,evidence:text,status:declines(text)?'declined':'unknown',turnId});
  for(const fact of facts)rememberFact(next,fact);
  if(!next.fields[target]&&!closingOnly(text)&&!unavailable){
    next.attempts[target]=(next.attempts[target]||0)+1;
    if(next.attempts[target]!>=2){const fact:Fact={field:target,value:'待医生进一步核实',evidence:text,status:'unknown',turnId};facts.push(fact);rememberFact(next,fact);}
  }
  next.nextField=FIELDS.find(f=>!next.fields[f])||null;
  let action:'ask'|'discuss'|'offer_close'|'patient_finished'=coreCollected(next)?'discuss':'ask';
  let reply:string;
  if(endRequested){
    next.phase='finished';action='patient_finished';reply=next.urgent?'通话已结束，您的描述已保存。请尽快联系急救服务或身边的人协助就医，不要等待随访审核。':'好的，本次通话已结束，您说的情况已保存，等待医生核对。感谢您的配合，再见。';
  }else if(next.urgent){
    next.phase='conversation';next.focusField='concerns';action='discuss';reply='您的描述需要及时由专业人员处理。请尽快联系当地急救服务或身边的人协助就医，不要等待本次随访。若还有情况要补充，我会继续听。';
  }else if(unavailable){
    next.phase=coreCollected(next)?'conversation':'collection';reply='您的原话已保留，但目前暂时无法整理和分析。您可以继续补充，或手动结束通话，之后请医生核对。';
  }else{
    const validAction=['ask','discuss','offer_close'].includes(extraction.action);
    if(validAction)action=extraction.action;
    const generated=validAction?safeSpokenReply(extraction.reply):undefined;
    if(validAction&&generated){
      reply=action==='offer_close'?generated.slice(0,175)+CLOSING_INVITATION:generated;
      next.focusField=FIELDS.includes(extraction.focusField)?extraction.focusField:next.nextField||'concerns';
    }else{
      action=coreCollected(next)?'discuss':'ask';
      reply=extraction.reply?'具体用药和治疗请与负责医生确认，我会记录您的问题。'+(next.nextField?QUESTIONS[next.nextField]:clarifications.concerns):fallbackReply(next,target,facts,isCorrection);
      next.focusField=next.nextField||'concerns';
      if(!next.nextField&&!extraction.reply)action='offer_close';
    }
    next.phase=action==='offer_close'?'closing':coreCollected(next)?'conversation':'collection';
  }
  return {state:next,facts,reply,handoff:false,priority:next.urgent?'urgent':unavailable?'attention':'routine',done:next.phase==='closing',endRequested,action,focusField:next.focusField,provider:extraction.provider||'custom',model:extraction.model||config.deepseekModel,elapsedMs:Date.now()-started,reason:endRequested?'patient_finished':next.urgent?'urgent_description':unavailable?'model_unavailable':'contextual_dialogue'};
}
