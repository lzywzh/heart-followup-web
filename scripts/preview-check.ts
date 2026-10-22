import assert from 'node:assert/strict';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.PREVIEW_ORIGIN||'http://127.0.0.1:3200';
const file=(await readdir('.runtime')).filter(f=>/^account-doctor-\d+\.json$/.test(f)).sort().at(-1);if(!file)throw new Error('未找到本机医生凭据文件');
const account=JSON.parse(await readFile('.runtime/'+file,'utf8'));
assert.equal((await fetch(origin+'/api/v1/health')).status,200);assert.equal((await fetch(origin+'/api/v1/patient/me')).status,401);
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:980}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(origin+'/platform/',{waitUntil:'networkidle'});await page.getByLabel('账号',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.getByRole('button',{name:'患者管理',exact:true}).waitFor();await page.getByRole('button',{name:'患者管理',exact:true}).click();await page.getByText('还没有患者，请先新建档案').waitFor();
  await page.getByRole('button',{name:'服务状态',exact:true}).click();await page.getByRole('heading',{name:'语音识别',exact:true}).waitFor();
  await mkdir('.runtime/acceptance',{recursive:true});await page.screenshot({path:'.runtime/acceptance/server-service-status.png',fullPage:true});assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'退出登录',exact:true}).click();console.log('Production preview passed: HTTPS assets/login, empty patient workspace, service/protocol status and logout.');
}finally{await browser.close();}
