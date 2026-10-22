import test from 'node:test';
import assert from 'node:assert/strict';
import {api,auth,login,logout,restoreAuth} from '../src/api.js';
test('wrong current password keeps the patient logged in so it can be corrected',async()=>{
  const original=globalThis.fetch;auth.account={id:'test',displayName:'isolated test',mustChangePassword:true};
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'PASSWORD_INCORRECT',message:'当前密码不正确'}}),{status:401});
  try{await assert.rejects(api('/auth/password','POST',{currentPassword:'wrong',newPassword:'only-test-value'}));assert.equal(auth.account?.id,'test');}finally{globalThis.fetch=original;auth.account=null;}
});
function deferredResponse(){let resolve!:(response:Response)=>void;const promise=new Promise<Response>(r=>{resolve=r;});return {promise,resolve};}
const authenticated=(id:string)=>new Response(JSON.stringify({account:{id,displayName:id},csrfToken:'csrf-'+id}),{status:200});
for(const status of [200,401])test('an old account '+status+' response cannot affect a newer login',async()=>{
  const original=globalThis.fetch;const delayed=deferredResponse();
  globalThis.fetch=async(url,options)=>String(url).endsWith('/auth/login')?authenticated(JSON.parse(options!.body as string).username):delayed.promise;
  try{
    await login('patientA','synthetic');const response=api('/me');const rejected=assert.rejects(response,(e:any)=>e.code==='STALE_AUTH');
    await login('patientB','synthetic');delayed.resolve(new Response(JSON.stringify(status===200?{patient:{name:'patientA'}}:{error:{code:'UNAUTHENTICATED',message:'expired'}}),{status}));
    await rejected;assert.equal(auth.account?.id,'patientB');
  }finally{globalThis.fetch=original;auth.account=null;}
});
test('late session restoration cannot replace a newer login',async()=>{
  const original=globalThis.fetch;const delayed=deferredResponse();
  globalThis.fetch=async(url,options)=>String(url).endsWith('/auth/login')?authenticated(JSON.parse(options!.body as string).username):delayed.promise;
  try{const oldRestore=restoreAuth();await login('patientB','synthetic');delayed.resolve(authenticated('patientA'));await oldRestore;assert.equal(auth.account?.id,'patientB');}finally{globalThis.fetch=original;auth.account=null;}
});
test('late logout completion cannot clear a newer login',async()=>{
  const original=globalThis.fetch;const delayed=deferredResponse();
  globalThis.fetch=async(url,options)=>String(url).endsWith('/auth/login')?authenticated(JSON.parse(options!.body as string).username):delayed.promise;
  try{
    await login('patientA','synthetic');const oldLogout=logout();const rejected=assert.rejects(oldLogout,(e:any)=>e.code==='STALE_AUTH');await login('patientB','synthetic');delayed.resolve(new Response('{"ok":true}',{status:200}));
    await rejected;assert.equal(auth.account?.id,'patientB');
  }finally{globalThis.fetch=original;auth.account=null;}
});
test('patient requests send cookies and the CSRF header without persisting tokens',async()=>{
  const original=globalThis.fetch;const requests:{url:string;options?:RequestInit}[]=[];
  globalThis.fetch=async(url,options)=>{requests.push({url:String(url),options});return new Response(JSON.stringify({account:{id:'test',displayName:'isolated test'},csrfToken:'memory-only'}),{status:200});};
  try{await login('test','only-test-value');await api('/me/contact','PATCH',{phone:''});assert.equal(requests[1].url,'/api/v1/patient/me/contact');assert.equal(requests[1].options?.credentials,'same-origin');assert.equal((requests[1].options?.headers as Record<string,string>)['x-csrf-token'],'memory-only');}finally{globalThis.fetch=original;auth.account=null;}
});
