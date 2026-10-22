import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { httpFixture, identity, boundPatient, testConfig } from './http-fixture.js';
import { synthesize } from '../src/voice/tts.js';
import { connectAsr } from '../src/voice/asr.js';

async function session(t:any, override:any={}, providers:any={}) {
  const f=await httpFixture(t,override,providers); const d=await identity(f.db,'clinician'); const p=await boundPatient(f.db,d.id);
  const s=(await f.app.inject({method:'POST',url:'/api/v1/patient/followups',headers:p.user.headers,payload:{clientRequestId:randomUUID()}})).json();
  return {...f,d,p,s};
}

test('voice: missing cloud configuration is explicit and never returns fake audio',async t=>{
  const f=await session(t);
  const c=await f.app.inject({url:'/api/v1/voice/capabilities',headers:f.p.user.headers});
  assert.equal(c.statusCode,200); assert.equal(c.json().ready,false);
  const r=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.s.id}/speech`,headers:f.p.user.headers,payload:{expectedVersion:f.s.version}});
  assert.equal(r.statusCode,503); assert.equal(r.headers['content-type']?.includes('audio'),false);
});

test('voice: audio download requires own identity, current version and one-use ticket',async t=>{
  const f=await session(t,{}, {tts:{synthesize:async()=>Buffer.from('ID3-test-audio')}});
  const another=await boundPatient(f.db,f.d.id);
  const r=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.s.id}/speech`,headers:f.p.user.headers,payload:{expectedVersion:f.s.version}});
  assert.equal(r.statusCode,200,r.body); const audio=r.json();
  const wrong=await f.app.inject({url:audio.downloadPath,headers:{...another.user.headers,'x-audio-ticket':audio.ticket}});
  assert.equal(wrong.statusCode,404);
  const ok=await f.app.inject({url:audio.downloadPath,headers:{...f.p.user.headers,'x-audio-ticket':audio.ticket}});
  assert.equal(ok.statusCode,200); assert.equal(ok.headers['content-type'],'audio/mpeg');
  assert.equal((await f.app.inject({url:audio.downloadPath,headers:{...f.p.user.headers,'x-audio-ticket':audio.ticket}})).statusCode,404);
  const second=(await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.s.id}/speech`,headers:f.p.user.headers,payload:{expectedVersion:f.s.version}})).json();
  await f.db.query('UPDATE followup_sessions SET version=version+1 WHERE id=$1',[f.s.id]);
  assert.equal((await f.app.inject({url:second.downloadPath,headers:{...f.p.user.headers,'x-audio-ticket':second.ticket}})).statusCode,404);
});

test('voice: expired socket tickets cannot establish a speech connection',async t=>{
  const f=await session(t,{}, {asr:{},tts:{synthesize:async()=>Buffer.from('ID3')}});
  const ticket=await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.s.id}/voice-ticket`,headers:f.p.user.headers});
  assert.equal(ticket.statusCode,200,ticket.body);
  await f.db.query("UPDATE voice_tickets SET expires_at=now()-interval '1 second'");
  const ws=await f.app.injectWS('/api/v1/voice/socket',{socket:{remoteAddress:'127.0.0.1'},headers:{'x-voice-ticket':ticket.json().ticket}} as any);
  const message=await new Promise<any>(resolve=>ws.on('message',data=>resolve(JSON.parse(data.toString()))));
  assert.equal(message.type,'error'); const closed=once(ws,'close');ws.terminate();await closed;
});

test('tts: provider waits for task-finished and joins binary frames using the same task ID',async t=>{
  const server=new WebSocketServer({port:0}); await once(server,'listening'); t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as any).port; const actions:any[]=[];
  server.on('connection',socket=>socket.on('message',raw=>{
    const m=JSON.parse(raw.toString());actions.push(m);
    if(m.header.action==='run-task')socket.send(JSON.stringify({header:{event:'task-started',task_id:m.header.task_id}}));
    if(m.header.action==='finish-task'){socket.send(Buffer.from('ID3'));socket.send(Buffer.from('audio'));socket.send(JSON.stringify({header:{event:'task-finished',task_id:m.header.task_id}}));}
  }));
  const audio=await synthesize({...testConfig,dashscopeApiKey:'test-key',dashscopeUrl:`ws://127.0.0.1:${port}`,ttsModel:'model',ttsVoice:'voice'},'您好');
  assert.equal(audio.toString(),'ID3audio');assert.deepEqual(actions.map(m=>m.header.action),['run-task','continue-task','finish-task']);
  assert.equal(new Set(actions.map(m=>m.header.task_id)).size,1);assert.equal(actions[1].payload.input.text,'您好');
});

test('asr: intermediate text is not final, final sentences preserve order and completion closes upstream',async t=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as any).port;const events:any[]=[];
  server.on('connection',socket=>socket.on('message',(raw,binary)=>{
    if(binary)return;const m=JSON.parse(raw.toString());
    if(m.header.name==='StartTranscription'){
      socket.send(JSON.stringify({header:{name:'TranscriptionStarted',status:20000000}}));
      socket.send(JSON.stringify({header:{name:'TranscriptionResultChanged',status:20000000},payload:{index:1,result:'中间结果'}}));
      socket.send(JSON.stringify({header:{name:'SentenceEnd',status:20000000},payload:{index:1,result:'第一句。'}}));
      socket.send(JSON.stringify({header:{name:'SentenceEnd',status:20000000},payload:{index:2,result:'第二句。'}}));
    }
    if(m.header.name==='StopTranscription')socket.send(JSON.stringify({header:{name:'TranscriptionCompleted',status:20000000}}));
  }));
  const asr=await connectAsr({...testConfig,aliyunAsrAppKey:'test-app',aliyunAsrUrl:`ws://127.0.0.1:${port}`},e=>events.push(e),async()=> 'temporary-token');
  await new Promise(resolve=>setTimeout(resolve,40));
  asr.send(Buffer.alloc(3200));const text=await asr.finish();
  assert.equal(text,'第一句。第二句。');assert.ok(events.some(e=>e.type==='partial'&&e.text==='中间结果'));
  assert.equal(events.filter(e=>e.type==='sentence').length,2);
});

test('voice: recording frames arriving during upstream handshake are retained',async t=>{
  let bytes=0;
  const f=await session(t,{}, {tts:{synthesize:async()=>Buffer.from('ID3')},asr:{connect:async()=>{
    await new Promise(resolve=>setTimeout(resolve,150));
    return {send:(data:Buffer)=>{bytes+=data.length;},finish:async()=>bytes===3200?'最近活动没有气喘':'',close:()=>{}};
  }}});
  const ticket=(await f.app.inject({method:'POST',url:`/api/v1/patient/followups/${f.s.id}/voice-ticket`,headers:f.p.user.headers})).json();
  const ws=await f.app.injectWS('/api/v1/voice/socket',{socket:{remoteAddress:'127.0.0.1'},headers:{'x-voice-ticket':ticket.ticket}} as any);
  const events:any[]=[];let ready!:()=>void;let done!:(m:any)=>void;
  const opened=new Promise<void>(resolve=>{ready=resolve;});const outcome=new Promise<any>(resolve=>{done=resolve;});
  ws.on('message',data=>{const e=JSON.parse(data.toString());events.push(e);if(e.type==='session.ready')ready();if(e.type==='assistant.text'||e.type==='error')done(e);});
  await opened;
  ws.send(JSON.stringify({type:'audio.start',expectedVersion:f.s.version}));ws.send(Buffer.alloc(3200));
  await new Promise(resolve=>setTimeout(resolve,450));ws.send(JSON.stringify({type:'audio.end'}));
  const final=await outcome;
  assert.equal(final.type,'assistant.text',JSON.stringify(final));assert.equal(final.session.turns[0].patientText,'最近活动没有气喘');
  const closed=once(ws,'close');ws.terminate();await closed;
});
