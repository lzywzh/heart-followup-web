import test from 'node:test';
import assert from 'node:assert/strict';
import {effectScope} from 'vue';
import {api,auth,useAuthApi,login,logout} from '../src/api.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function signIn(id:string,csrf:string){auth.account={id,role:'clinician',displayName:id};auth.csrfToken=csrf;}

// Removing the response lifetime check exposes A's data or signs B out.
for(const status of [200,401])test(`doctor A delayed ${status} cannot complete in doctor B session`,async()=>{
  signIn('doctor-a','csrf-a');
  const response=deferred<Response>();const original=globalThis.fetch;
  globalThis.fetch=async()=>response.promise;
  try{
    const request=api('/clinician/patients');
    auth.account=null;auth.csrfToken='';signIn('doctor-b','csrf-b');
    response.resolve(new Response(JSON.stringify(status===200?{items:[{name:'A private patient'}]}:{error:{message:'A expired'}}),{status}));
    const result=await request.then(value=>({value,error:null}),error=>({value:null,error}));
    assert.equal(auth.account?.id,'doctor-b','late 401 must not sign the new doctor out');
    assert.equal(result.value,null,'old response must not reach the new account caller');
    assert.equal(result.error?.code,'STALE_AUTH');
  }finally{globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('rotated CSRF invalidates an in-flight response even for the same doctor id',async()=>{
  signIn('doctor-a','csrf-old');const response=deferred<Response>();const original=globalThis.fetch;
  globalThis.fetch=async()=>response.promise;
  try{
    const request=api('/clinician/reviews');signIn('doctor-a','csrf-new');
    response.resolve(new Response(JSON.stringify({items:[{name:'old session review'}]})));
    await assert.rejects(request,(error:any)=>error.code==='STALE_AUTH');
    assert.equal(auth.csrfToken,'csrf-new');
  }finally{globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('response body parsing is included in the auth lifetime',async()=>{
  signIn('doctor-a','csrf-a');const body=deferred<unknown>();const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,status:200,json:()=>body.promise}) as Response;
  try{
    const request=api('/clinician/patients');await Promise.resolve();signIn('doctor-b','csrf-b');
    body.resolve({items:[{name:'A private patient'}]});
    await assert.rejects(request,(error:any)=>error.code==='STALE_AUTH');
  }finally{globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('current doctor request returns data and sends its captured CSRF',async()=>{
  signIn('doctor-a','csrf-current');const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{assert.equal((init?.headers as Record<string,string>)['x-csrf-token'],'csrf-current');return new Response(JSON.stringify({items:[{id:'current-patient'}]}));};
  try{assert.deepEqual(await api('/clinician/patients'),{items:[{id:'current-patient'}]});assert.equal(auth.account.id,'doctor-a');}
  finally{globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('current doctor 401 clears that doctor session and CSRF',async()=>{
  signIn('doctor-a','csrf-a');const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Expired'}}),{status:401});
  try{await assert.rejects(api('/clinician/patients'));assert.equal(auth.account,null);assert.equal(auth.csrfToken,'');}
  finally{globalThis.fetch=original;}
});

test('an old workspace action cannot issue a request under a new doctor session',async()=>{
  signIn('doctor-a','csrf-a');const scope=effectScope();const scopedApi=scope.run(()=>useAuthApi())!;const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{++requests;return new Response('{}');};
  try{signIn('doctor-b','csrf-b');await assert.rejects(scopedApi('/clinician/tasks','POST',{patientId:'A patient'}),(error:any)=>error.code==='STALE_AUTH');assert.equal(requests,0);}
  finally{scope.stop();globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('a disposed workspace cannot receive a delayed response in the same login',async()=>{
  signIn('doctor-a','csrf-a');const scope=effectScope();const scopedApi=scope.run(()=>useAuthApi())!;const response=deferred<Response>();const original=globalThis.fetch;
  globalThis.fetch=async()=>response.promise;
  try{const request=scopedApi('/clinician/patients');scope.stop();response.resolve(new Response('{"items":[]}'));await assert.rejects(request,(error:any)=>error.code==='STALE_AUTH');}
  finally{scope.stop();globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});

test('logout and relogin with identical doctor id and CSRF still creates a new lifetime',async()=>{
  signIn('doctor-a','same-csrf');const response=deferred<Response>();const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url).endsWith('/auth/logout')?new Response('{}'):String(url).endsWith('/auth/clinician/login')?new Response(JSON.stringify({account:{id:'doctor-a',role:'clinician'},csrfToken:'same-csrf'})):response.promise;
  try{const request=api('/clinician/patients');await logout();await login('doctor-a','synthetic-only');response.resolve(new Response('{"items":[]}'));await assert.rejects(request,(error:any)=>error.code==='STALE_AUTH');assert.equal(auth.account.id,'doctor-a');}
  finally{globalThis.fetch=original;auth.account=null;auth.csrfToken='';}
});
