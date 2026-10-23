import test from 'node:test';
import assert from 'node:assert/strict';
import {runDialogue} from '../src/agents/dialogue.js';
import {initialState, collectionSummary, rebuildState, type CollectionState} from '../src/agents/protocol.js';
import {testConfig} from './http-fixture.js';

function covered():CollectionState {
  const s=initialState();
  for(const field of ['breathing','swelling','weight','medication'] as const)s.fields[field]={field,value:'已报告',evidence:'已报告',status:'reported'};
  s.nextField='concerns';return s;
}
async function turn(text:string,plan:any={},state:CollectionState=initialState(),extra:any={}) {
  return runDialogue({config:testConfig,providers:{dialogue:{nextTurn:async()=>({facts:[],...plan})}},text,state,patient:{},turnId:'turn-'+state.answerCount,isCorrection:false,...extra});
}

test('Agent chooses a contextual followup on an already covered field',async()=>{
  const reply='您刚才说上楼有点喘，休息多久能缓解？';
  const r=await turn('今天上楼有点喘',{facts:[{field:'breathing',evidence:'上楼有点喘'}],reply,action:'ask',focusField:'breathing'});
  assert.equal(r.reply,reply);assert.equal(r.state.focusField,'breathing');assert.equal(r.done,false);
});
test('actual model request includes the record and last twelve valid history turns',async()=>{
  let request:any;
  await runDialogue({config:{...testConfig,collectionMode:'ai',deepseekApiKey:'synthetic-test-key'},providers:{fetch:async(_url:any,init:any)=>{request=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({facts:[],reply:'您休息时会觉得喘吗？',action:'ask',focusField:'breathing'})}}]});}},
    text:'上楼有点喘',state:initialState(),patient:{medical_record:{diagnosis:'synthetic-record'}},turnId:'test',isCorrection:false,
    history:Array.from({length:16},(_,n)=>({patientText:'patient-'+n,assistantText:'assistant-'+n}))} as any);
  const input=JSON.parse(request.messages[1].content);
  assert.equal(input.history.length,12);assert.equal(input.history[0].patientText,'patient-4');assert.equal(input.patient.medicalRecord.diagnosis,'synthetic-record');
});
test('core coverage and more than ten turns do not end free conversation',async()=>{
  const s=covered();s.answerCount=18;
  const r=await turn('我还想问睡眠的问题',{reply:'您最近入睡困难，还是容易醒？',action:'discuss'},s);
  assert.equal(r.done,false);assert.equal(r.state.phase,'conversation');assert.match(r.reply,/容易醒/);
});
test('Agent offers closure but a new patient question reopens conversation',async()=>{
  const close=await turn('今天先说这些',{reply:'还有什么想补充的吗？',action:'offer_close'},covered());
  assert.equal(close.done,true);assert.equal((close as any).endRequested,false);assert.equal(close.state.phase,'closing');assert.match(close.reply,/继续.*问|继续.*聊/);
  const next=await turn('我还想问睡不好的问题',{reply:'您最近大约睡几个小时？',action:'discuss'},close.state);
  assert.equal(next.state.phase,'conversation');assert.equal(next.done,false);
});
test('unsupported model end action cannot finish for the patient',async()=>{
  const r=await turn('我最近晚上睡不好',{reply:'结束吧',action:'end'},covered());
  assert.equal((r as any).endRequested,false);assert.notEqual(r.state.phase,'finished');assert.doesNotMatch(r.reply,/结束吧/);
});
for(const text of ['没有气短','体重没变化','肿胀没有了','不要结束','没别的，但我还想问睡眠','我不想结束通话','没有了，不过我还想问','医生说没什么要补充了','不知道要不要结束通话','护士告诉我没什么要补充了','没有不舒服，我还想继续聊','我不是说没什么要补充了','我没有说没什么要补充了','并非没有其他问题了','家人说没什么要补充了','朋友说，没什么要补充了'])test('does not mistake medical negatives or ambiguous ending for hangup: '+text,async()=>{
  const s=covered();s.phase='closing';const r=await turn(text,{},s);
  assert.equal((r as any).endRequested,false);
});
test('bare no-more only finishes when the assistant actually offered closure',async()=>{
  assert.equal((await turn('没有了',{},covered()) as any).endRequested,false);
  const s=covered();s.phase='closing';assert.equal((await turn('没有了',{},s) as any).endRequested,true);
});
for(const text of ['没什么要补充了','先聊到这','结束通话','其他没有想补充的情况','不需要补充了','不用再补充了','没有其他问题了','没有什么要问了','脚还有点肿，没什么要补充了','最近不能平躺，没什么要补充了','最近不想吃饭，没什么要补充了','没什么要补充了，谢谢'])test('explicit patient ending is final: '+text,async()=>{
  const r=await turn(text,{},covered());assert.equal((r as any).endRequested,true);assert.equal(r.state.phase,'finished');assert.match(r.reply,/再见|结束/);
});
test('model cannot announce a finished call while the patient is still asking',async()=>{
  const r=await turn('还有睡眠的问题',{reply:'本次通话已结束，再见。',action:'discuss'},covered());
  assert.doesNotMatch(r.reply,/通话已结束/);assert.equal(r.endRequested,false);
});
test('an unsafe closure reply cannot put a normal medical followup into closing context',async()=>{
  const s=initialState();s.fields.breathing={field:'breathing',value:'呼吸还好',evidence:'呼吸还好',status:'reported'};s.nextField='swelling';
  const first=await turn('呼吸还好',{reply:'可以停用原来的药',action:'offer_close'},s);
  assert.notEqual(first.state.phase,'closing');assert.equal(first.action,'ask');
  assert.equal((await turn('没有了',{},first.state)).endRequested,false);
});
test('an unrelated correction preserves urgent hold from valid earlier dialogue',async()=>{
  const state=rebuildState([{id:'urgent',status:'completed',patient_text:'现在喘得说不出完整的话',evidence:[]},{id:'weight',status:'completed',patient_text:'体重六十五公斤',evidence:[{field:'weight',value:'体重六十五公斤',evidence:'体重六十五公斤',status:'reported'}]}]);
  const r=await turn('更正，体重六十六公斤',{facts:[{field:'weight',evidence:'体重六十六公斤'}]},state,{isCorrection:true});
  assert.equal(r.priority,'urgent');assert.match(r.reply,/急救/);assert.doesNotMatch(r.reply,/最近.*体重/);
});
test('new final fact is collected before the patient ends',async()=>{
  const r=await turn('最近晚上睡不好，没什么要补充了',{facts:[{field:'concerns',evidence:'最近晚上睡不好'}]},covered());
  assert.equal((r as any).endRequested,true);assert.equal(r.state.fields.concerns?.value,'最近晚上睡不好');
});
test('multiple concerns and corrected evidence survive without closing boilerplate overwrites',async()=>{
  const first=await turn('最近晚上睡不好',{facts:[{field:'concerns',evidence:'最近晚上睡不好'}],action:'discuss'},covered());
  const second=await turn('白天也容易累',{facts:[{field:'concerns',evidence:'白天也容易累'}],action:'discuss'},first.state);
  const last=await turn('没什么要补充了',{facts:[{field:'concerns',evidence:'没什么要补充了'}]},second.state);
  const item=collectionSummary(last.state).items.find(i=>i.field==='concerns')!;
  assert.match(item.value,/睡不好/);assert.match(item.value,/容易累/);assert.doesNotMatch(item.value,/没什么要补充/);
  const rebuilt=rebuildState([{id:'old',status:'completed',evidence:first.facts},{id:'second',status:'completed',evidence:second.facts},{id:'fix',status:'completed',supersedes_id:'old',evidence:[{field:'concerns',value:'睡得好了',evidence:'睡得好了',status:'reported',turnId:'fix'}]}]);
  const corrected=collectionSummary(rebuilt).items.find(i=>i.field==='concerns')!;
  assert.doesNotMatch(corrected.value,/睡不好/);assert.match(corrected.value,/容易累/);assert.match(corrected.value,/睡得好了/);
});
test('unsafe treatment output falls back without prescribing',async()=>{
  for(const reply of ['把利尿剂加倍服用','可以停用原来的药','您确诊为急性心衰','医生已经收到通知']){
    const r=await turn('药怎么吃',{reply,action:'discuss'},covered());assert.notEqual(r.reply,reply);assert.match(r.reply,/医生|医嘱/);
  }
});
test('a model reminder against changing medication can still ask a natural contextual question',async()=>{
  const reply='漏服的情况会记录下来，请不要自行加倍服用，具体问医生。最近晚上睡不好，是难入睡还是容易醒？';
  const r=await turn('个别天中午忘记吃药，晚上睡不好',{reply,action:'discuss'},covered());assert.equal(r.reply,reply);
});
test('model failure and urgent symptoms retain an open conversation',async()=>{
  const failed=await turn('晚上不舒服',{},covered(),{providers:{dialogue:{nextTurn:async()=>{throw new Error('offline');}}}});
  assert.equal(failed.handoff,false);assert.equal((failed as any).endRequested,false);assert.match(failed.reply,/暂时|暂未|目前/);assert.match(failed.reply,/继续/);
  const urgent=await turn('现在喘得说不出完整的话',{},covered());
  assert.equal(urgent.handoff,false);assert.equal(urgent.priority,'urgent');assert.match(urgent.reply,/急救/);assert.doesNotMatch(urgent.reply,/已通知|已收到/);
});
