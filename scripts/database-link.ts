import 'dotenv/config';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir,writeFile } from 'node:fs/promises';
async function reachable(host:string,port:number){return new Promise<boolean>(resolve=>{const s=createConnection({host,port});s.setTimeout(1200);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>{s.destroy();resolve(false);});s.once('timeout',()=>{s.destroy();resolve(false);});});}
export async function ensureDatabaseLink(){
  if(!process.env.DATABASE_URL)throw new Error('请先按 README 配置 .env 中的数据库连接');
  const u=new URL(process.env.DATABASE_URL);const port=Number(u.port||5432);if(await reachable(u.hostname,port))return;
  const alias=process.env.SSH_DB_ALIAS;if(!alias||u.hostname!=='127.0.0.1'||port===5432)throw new Error('无法连接数据库，请启动 PostgreSQL 或配置 SSH 隧道');
  await mkdir('.runtime',{recursive:true});const log=openSync('.runtime/db-tunnel.log','a');
  const ssh=spawn('ssh',['-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-L',`127.0.0.1:${port}:127.0.0.1:5432`,alias],{detached:true,stdio:['ignore','ignore',log],windowsHide:true});
  let failed=false;ssh.on('error',()=>{failed=true;});ssh.unref();await writeFile('.runtime/db-tunnel.pid',String(ssh.pid||''));
  for(let n=0;n<20&&!failed;n++){await new Promise(r=>setTimeout(r,300));if(await reachable(u.hostname,port))return;}
  throw new Error('SSH 数据库隧道未建立，请检查已配置的 SSH 别名与私钥');
}
