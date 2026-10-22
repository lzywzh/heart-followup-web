// UI-only synthetic fixtures: no database or live account mutation.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const base=process.env.PATIENT_UI_URL||'http://127.0.0.1:5174/patient/';
const browser=await chromium.launch({channel:process.env.PATIENT_BROWSER_CHANNEL||'msedge',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1000}});
const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
let authenticated=false;let firstLogin=false;
const current={id:'synthetic-session',version:1,status:'active',greeting:'您好，请说说今天的身体情况。',turns:[]};
await context.addInitScript({content:`(() => {
  let current;
  window.SpeechSynthesisUtterance=class { constructor(text){this.text=text;} };
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{lang:'zh-CN',name:'Synthetic Chinese test voice'}],resume(){},cancel(){current=undefined;},speak(u){if(u.text.trim())current=u;},addEventListener(){},removeEventListener(){}}});
  window.__finishSpeech=()=>current?.onend?.(new Event('end'));
})();`});
await page.route('**/api/v1/patient/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let body:unknown={};let status=200;
  if(path.endsWith('/auth/session')){if(!authenticated){status=401;body={error:{message:'请登录'}};}else body={account:{id:'synthetic',displayName:'界面验证',mustChangePassword:firstLogin},csrfToken:'synthetic-csrf'};}
  else if(path.endsWith('/auth/login')){authenticated=true;body={account:{id:'synthetic',displayName:'界面验证',mustChangePassword:firstLogin},csrfToken:'synthetic-csrf'};}
  else if(path.endsWith('/auth/password')){firstLogin=false;body={ok:true};}
  else if(path.endsWith('/auth/logout')){authenticated=false;body={ok:true};}
  else if(path.endsWith('/me'))body={patient:{id:'synthetic',name:'界面验证',birthDate:'1970-01-01',sex:'unspecified',phone:'',emergencyContact:'',emergencyPhone:'',personalNotes:'',medicalRecord:{diagnosis:'仅用于界面布局验证'}},tasks:[{id:'synthetic-task',title:'健康随访',status:'pending',scheduled_at:'2026-10-21T06:00:00Z',available:true,overdue:false}],history:[],activeSession:null};
  else if(path.endsWith('/voice/capabilities'))body={asr:true,tts:null,ready:true,ttsMode:'browser',message:'设备语音模式'};
  else if(path.endsWith('/followups'))body=current;
  else if(path.endsWith('/pause'))body={...current,status:'paused'};
  else if(path.includes('/followups/'))body=current;
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
});
const output='apps/patient-web/.qa';await mkdir(output,{recursive:true});
async function noOverflow(label:string){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' overflows');}
try{
  await page.goto(base);await page.getByRole('heading',{name:'欢迎回来'}).waitFor();await noOverflow('desktop login');await page.screenshot({path:output+'/login-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await noOverflow('mobile login');await page.screenshot({path:output+'/login-mobile.png',fullPage:true});
  firstLogin=true;await page.getByLabel('患者账号',{exact:true}).fill('synthetic');await page.getByLabel('密码',{exact:true}).fill('synthetic-only');await page.getByRole('button',{name:/登录患者服务/}).click();
  await page.getByRole('heading',{name:'设置您的新密码'}).waitFor();await noOverflow('forced password');await page.getByLabel('初始密码',{exact:true}).fill('synthetic-only');await page.getByLabel('新密码',{exact:true}).fill('synthetic-new-only');await page.getByLabel('再次输入新密码',{exact:true}).fill('synthetic-new-only');await page.getByRole('button',{name:'保存并进入服务'}).click();
  await page.getByRole('heading',{name:'界面验证，您好。'}).waitFor();await noOverflow('mobile home');await page.screenshot({path:output+'/home-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await noOverflow('desktop home');await page.screenshot({path:output+'/home-desktop.png',fullPage:true});
  for(const name of ['健康档案','历史记录','联系信息']){await page.getByRole('button',{name,exact:true}).click();await noOverflow(name);}
  await page.getByRole('button',{name:'我的随访',exact:true}).click();await page.getByRole('button',{name:/开始语音随访/}).click();await page.getByRole('heading',{name:'一次安心的健康对话'}).waitFor();
  assert.equal(await page.locator('input,textarea,[contenteditable="true"]').count(),0,'voice screen must not contain text-entry UI');
  await page.setViewportSize({width:390,height:844});await noOverflow('mobile call');await page.screenshot({path:output+'/call-ready-mobile.png',fullPage:true});
  await page.getByRole('button',{name:/开启麦克风，开始随访/}).click();await page.getByRole('heading',{name:'请听助手说话'}).waitFor();
  await page.getByRole('button',{name:'打断，我来说'}).click();await page.getByRole('heading',{name:'正在听您说话'}).waitFor();
  await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByRole('heading',{name:'通话已暂停'}).waitFor();await page.screenshot({path:output+'/call-paused-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('Patient browser smoke passed: login, forced password, dashboard, records, history, contact, voice-only call, interruption, pause; desktop/mobile overflow checks. Media and API boundaries are synthetic.');
}finally{await browser.close();}
