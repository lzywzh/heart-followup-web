import 'dotenv/config';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createDatabase} from '../apps/api/src/db/database.js';
import {hashPassword} from '../apps/api/src/modules/auth.js';
import {writePrivate} from './private-file.js';
export async function provisionAccount(role:'admin'|'clinician',username:string,name:string){
  if(!/^[a-zA-Z0-9_-]{3,60}$/.test(username)||!name.trim())throw new Error('请输入有效账号与姓名');
  const url=process.env.MIGRATION_DATABASE_URL||process.env.DATABASE_URL;if(!url)throw new Error('未配置数据库');
  const db=createDatabase(url);try{
    const existing=await db.query('SELECT id FROM accounts WHERE login_name=$1',[username]);if(existing.rowCount)return null;
    const password=randomBytes(18).toString('base64url')+'aA1!';
    const credentials={role,username,name,password,createdAt:new Date().toISOString()};
    const path=resolve('.runtime',`account-${username}-${Date.now()}.json`);
    // A password file is durable before the database account is created.
    await writePrivate(path,JSON.stringify(credentials,null,2));
    await db.query('INSERT INTO accounts(id,role,display_name,login_name,password_hash) VALUES($1,$2,$3,$4,$5)',[randomUUID(),role,name,username,await hashPassword(password)]);
    return path;
  }finally{await db.close();}
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/scripts/admin.ts')){
  const [role,username,name]=process.argv.slice(2);if(!['admin','clinician'].includes(role)||!username||!name)throw new Error('用法：npm run account:create -- clinician doctor 姓名');
  const path=await provisionAccount(role as 'admin'|'clinician',username,name);console.log(path?'账户已创建，初始密码保存在受限文件：'+path:'该账号已存在，未更改密码。');
}
