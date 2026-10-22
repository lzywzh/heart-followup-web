import test from 'node:test';
import assert from 'node:assert/strict';
import {runDialogue} from '../src/agents/dialogue.js';
import {initialState,type Fact} from '../src/agents/protocol.js';
import {testConfig} from './http-fixture.js';

async function turn(text:string,facts:Partial<Fact>[]=[],state=initialState()){
  return runDialogue({config:testConfig,providers:{dialogue:{nextTurn:async()=>({facts})}},text,state,patient:{},turnId:'style-test',isCorrection:false});
}
test('a vague answer receives a more concrete clarification rather than the identical question',async()=>{
  const result=await turn('就是平常那样');
  assert.match(result.reply,/走路|上楼|躺下/);
  assert.notEqual(result.reply,'没关系，我们再确认一下。最近活动或休息时，呼吸感觉怎么样？');
});
test('unknown weight gets a relevant acknowledgement without inventing a number or normal result',async()=>{
  const state=initialState();state.nextField='weight';
  state.fields.breathing={field:'breathing',value:'有时喘',evidence:'有时喘',status:'reported'};
  state.fields.swelling={field:'swelling',value:'不知道',evidence:'不知道',status:'unknown'};
  const result=await turn('最近没有量过体重',[],state);
  assert.equal(result.state.fields.weight?.status,'unknown');
  assert.match(result.reply,/没量|没有测量/);assert.match(result.reply,/用药|药/);
  assert.doesNotMatch(result.reply,/体重正常|没有异常|不用担心/);
});
test('completed collection uses a spoken ending instruction without asking another question',async()=>{
  const state=initialState();
  for(const field of ['breathing','swelling','weight','medication'] as const)state.fields[field]={field,value:'已报告',evidence:'已报告',status:'reported'};
  state.nextField='concerns';
  const result=await turn('其他没有想补充的情况',[{field:'concerns',evidence:'其他没有想补充的情况',status:'reported'}],state);
  assert.equal(result.done,true);assert.match(result.reply,/结束通话/);assert.doesNotMatch(result.reply,/请核对采集摘要/);
});
