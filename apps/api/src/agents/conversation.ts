import type {CollectionState} from './protocol.js';

export const CLOSING_INVITATION='还有什么想补充的吗？您也可以继续问，我会接着听。';
const clean=(text:string)=>text.replace(/[\s，。！？、；,.!?;：:]/g,'');

/** Ending is a patient decision. Model actions and symptom negatives cannot hang up. */
export function patientFinishIntent(text:string,state:CollectionState):boolean {
  const clauses=text.split(/[，。！？；,.!?;\n]/).map(clean).filter(Boolean);
  while(clauses.length&&/^(?:谢谢|再见|好的?|嗯)+$/.test(clauses.at(-1)!))clauses.pop();
  const value=clauses.at(-1)||'';
  if(clauses.slice(0,-1).some(clause=>/(?:说|告诉(?:我|你)?|表示)(?:过)?$|(?:还(?:想|要|有)|继续).*(?:问|聊|说|问题)/.test(clause)))return false;
  if(/不(?:要|想|愿|能)|别(?:结束|挂断|停止)|还(?:想|要|有|没)|继续(?:问|聊|说)|但|不过|可是|不确定|不知道|要不要|能不能|是不是|如果|假如|(?:怎么|如何).*(?:结束|挂断)/.test(value))return false;
  if(/^(?:好的?|嗯|谢谢|那|我|我们)*(?:结束(?:这次)?(?:通话|随访)|挂断(?:电话|通话)?|停止(?:这次)?随访|先聊到这(?:里)?|就聊到这(?:里)?)(?:吧|了|谢谢|再见)*$/.test(value))return true;
  if(/^(?:好的?|嗯|那|我|我们|其他)*(?:没(?:有)?什么|没(?:有)?其他|没(?:有)?别的|其他没(?:有)?)(?:想|要|需要)?(?:补充|问|说)(?:的|了|情况|问题)*$/.test(value))return true;
  if(/^(?:我)?(?:(?:不需要|不用)(?:再)?补充(?:了|什么了)?|(?:没有|没)(?:其他|别的)问题了?)$/.test(value))return true;
  return state.phase==='closing'&&/^(?:好的?|嗯|谢谢|我)?(?:没(?:有)?了|没问题了|没别的了|没其他了|不需要补充了|不用补充了)(?:谢谢|再见)?$/.test(value);
}

export function closingOnly(text:string):boolean {
  const value=clean(text);
  return /^(?:好的?|嗯|谢谢|那|我|我们|其他)*(?:(?:没(?:有)?什么|没(?:有)?其他|没(?:有)?别的|没(?:有)?|不需要|不用)(?:再|想|要|需要)?(?:补充|问|说)?(?:的|了|情况|问题)*|先聊到这里?|结束(?:通话|随访)|挂断(?:电话|通话)?)(?:吧|谢谢|再见)*$/.test(value);
}

/** A narrow runtime guard in addition to the medical scope in the system prompt. */
export function safeSpokenReply(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  const reply=value.trim();
  const checked=reply.replace(/(?:不要|不能|请勿|切勿|不建议|不应)(?:自行|擅自)?(?:加倍(?:服用)?|加量|减量|停用|停服|换药)/g,'');
  if(!reply||reply.length>220||/[<>{}]/.test(reply)||/(?:加倍|加量|减量|停用|停服|换药|确诊|诊断为|开处方|医生(?:已经|已)收到|已(?:经)?通知医生|通话(?:已经|已)结束|再见|(?:服用|口服).{0,12}\d+\s*(?:片|粒|毫克|mg))/i.test(checked))return;
  return reply;
}
