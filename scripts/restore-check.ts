import 'dotenv/config';
import {spawn,execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
const alias=process.env.SSH_DB_ALIAS||'';if(!alias)throw new Error('Set SSH_DB_ALIAS to your own server alias before this operation');const input=process.argv[2];if(!input?.endsWith('.dump'))throw new Error('用法：npm run db:restore-check -- 备份文件.dump');
const db='hf_v2_restore_'+randomBytes(8).toString('hex');
function ssh(command:string){return execFileSync('ssh',['-T','-o','BatchMode=yes',alias,command],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});}
ssh(`sudo -n -u postgres createdb ${db}`);
try{
  const child=spawn('ssh',['-T','-o','BatchMode=yes',alias,`sudo -n -u postgres pg_restore --no-owner --no-acl --exit-on-error -d ${db}`],{stdio:['pipe','ignore','pipe'],windowsHide:true});child.stderr.resume();
  const exit=new Promise<void>((r,j)=>{child.on('error',()=>j(new Error('恢复检查未启动')));child.on('exit',code=>code===0?r():j(new Error('恢复检查失败')));});
  await Promise.all([pipeline(createReadStream(resolve(input)),child.stdin),exit]);
  const count=ssh(`sudo -n -u postgres psql -X -At -d ${db} -c "SELECT count(*) FROM schema_migrations"`).trim();if(Number(count)<2)throw new Error('恢复后的迁移记录不完整');
  console.log('备份已成功恢复到独立临时数据库并检查；业务数据库没有覆盖。');
}finally{ssh(`sudo -n -u postgres dropdb --force ${db}`);}
