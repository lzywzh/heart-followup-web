// Synthetic browser-only account lifetime regression. No application database.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,type Page} from 'playwright';
import {resolve} from 'node:path';
const server=await createServer({root:resolve('apps/clinician-web'),configFile:resolve('apps/clinician-web/vite.config.ts'),server:{port:5188,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});
const failures:string[]=[];
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const account=(id:string)=>({id,role:'clinician',displayName:id});
const task=(name:string)=>({id:name,name,title:'Synthetic scheduled task',status:'pending',scheduled_at:'2026-10-21T00:00:00Z'});
async function scenario(name:string,mode:'data'|'401'|'clear'|'overlap'){
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  let active='doctorA';let gateNext=false;let held=false;let latest=false;
  const entered=deferred();const release=deferred();
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','');let status=200;let body:unknown={};
    if(path==='/auth/session')body={account:account(active),csrfToken:'synthetic-'+active};
    else if(path==='/auth/clinician/login'){active=route.request().postDataJSON().username;body={account:account(active),csrfToken:'synthetic-'+active};}
    else if(path==='/auth/logout')active='';
    else if(path==='/clinician/tasks'){
      const owner=active;const delay=gateNext&&!held;const item=task(owner==='doctorA'?(latest?'A latest task':'A private task'):'B current task');
      if(delay){held=true;entered.resolve();await release.promise;if(mode==='401'){status=401;body={error:{message:'Expired A session'}};}else body={items:[item]};}
      else body={items:[item]};
    }else if(path==='/health')body={environment:'production'};
    else if(path==='/clinician/voice/capabilities')body={asr:true,asrStatus:'available',ttsMode:'browser'};
    else if(path==='/clinician/protocol')body={};
    else body={items:[]};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  async function settle(){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
  async function signIn(){await page.locator('#login-username').fill('doctorB');await page.locator('#login-password').fill('synthetic-only');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await page.getByRole('heading',{name:'您好，doctorB'}).waitFor();}
  try{
    await page.goto('http://localhost:5188/doctor/');await page.getByText('A private task',{exact:true}).waitFor();await settle();
    if(mode==='clear'){
      await page.getByRole('button',{name:'退出医生登录',exact:true}).click();gateNext=true;await signIn();await entered.promise;await settle();
      assert.equal(await page.getByText('A private task',{exact:true}).count(),0,'new doctor must never see cached previous doctor tasks while its own refresh is pending');
    }else{
      gateNext=true;await page.getByRole('button',{name:'刷新数据',exact:true}).click();await entered.promise;
      if(mode==='overlap'){latest=true;await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByText('A latest task',{exact:true}).waitFor();}
      else{await page.getByRole('button',{name:'退出医生登录',exact:true}).click();await signIn();await page.getByText('B current task',{exact:true}).waitFor();}
      const received=page.waitForResponse(response=>response.url().endsWith('/clinician/tasks'));release.resolve();await(await received).finished();await settle();
      if(mode==='overlap'){assert.equal(await page.getByText('A latest task',{exact:true}).count(),1,'older same-doctor refresh must not overwrite newer results');assert.equal(await page.getByText('A private task',{exact:true}).count(),0);}
      else{assert.equal(await page.getByRole('heading',{name:'您好，doctorB'}).count(),1,'late A 401 must not log B out');assert.equal(await page.getByText('B current task',{exact:true}).count(),1,'late A data must not replace B tasks');assert.equal(await page.getByText('A private task',{exact:true}).count(),0);}
    }
    console.log('PASS: '+name);
  }catch(error){failures.push(name+': '+String(error));console.error('FAIL: '+name+' — '+String(error));}
  finally{release.resolve();await page.close();}
}
try{
  await scenario('delayed doctor A refresh after doctor B login','data');
  await scenario('delayed doctor A 401 after doctor B login','401');
  await scenario('cached doctor A lists cleared before doctor B data arrives','clear');
  await scenario('overlapping same-doctor refresh keeps latest response','overlap');
  assert.equal(failures.length,0,failures.join('\n'));
}finally{await browser.close();await server.close();}
