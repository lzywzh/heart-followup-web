// Synthetic account-lifetime regression. Never uses the application database.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
const server=await createServer({root:resolve('apps/patient-web'),configFile:resolve('apps/patient-web/vite.config.ts'),server:{port:5189,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
let active='';let releaseA!:()=>void;const delayedA=new Promise<void>(r=>{releaseA=r;});let startedA!:()=>void;const seenA=new Promise<void>(r=>{startedA=r;});
const account=(id:string)=>({id,displayName:id,mustChangePassword:false});
await page.route('**/api/v1/patient/**',async route=>{
  const path=new URL(route.request().url()).pathname;let status=200;let body:unknown={};
  if(path.endsWith('/auth/session')){status=401;body={error:{message:'login required'}};}
  else if(path.endsWith('/auth/login')){active=route.request().postDataJSON().username;body={account:account(active),csrfToken:'synthetic-'+active};}
  else if(path.endsWith('/auth/logout'))active='';
  else if(path.endsWith('/me')){const id=active;if(id==='patientA'){startedA();await delayedA;}body={patient:{id,name:id,birthDate:'1970-01-01',sex:'unspecified',phone:id==='patientA'?'111111':'222222',emergencyContact:id,emergencyPhone:'',personalNotes:id,medicalRecord:{}},tasks:[],history:[],activeSession:null};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
});
async function signIn(name:string){await page.getByLabel('患者账号',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill('synthetic-only');await page.getByRole('button',{name:/登录患者服务/}).click();}
try{
  await page.goto('http://localhost:5189/patient/');await signIn('patientA');await seenA;
  await page.getByRole('button',{name:'退出',exact:true}).click();await signIn('patientB');await page.getByRole('heading',{name:'patientB，您好。'}).waitFor();
  const lateResponse=page.waitForResponse(response=>response.url().endsWith('/patient/me'));releaseA();await(await lateResponse).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('heading',{name:'patientB，您好。'}).count(),1);assert.equal(await page.getByRole('heading',{name:'patientA，您好。'}).count(),0);
  await page.getByRole('button',{name:'联系信息',exact:true}).click();assert.equal(await page.getByLabel('您的联系电话',{exact:true}).inputValue(),'222222');
  console.log('PASS: delayed patient A workspace and contact response cannot render in patient B login.');
}finally{releaseA();await browser.close();await server.close();}
