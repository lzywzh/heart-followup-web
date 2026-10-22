import 'dotenv/config';
import { spawn } from 'node:child_process';
import { ensureDatabaseLink } from './database-link.js';
await ensureDatabaseLink();
const children=[spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','watch','apps/api/src/main.ts'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,['node_modules/vite/bin/vite.js','apps/clinician-web','--host','127.0.0.1','--port','5173','--strictPort'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,['node_modules/vite/bin/vite.js','apps/patient-web','--host','127.0.0.1','--port','5174','--strictPort'],{stdio:'inherit',windowsHide:true})];
let closing=false;function stop(){if(closing)return;closing=true;for(const c of children)c.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const c of children){c.on('error',()=>{stop();process.exitCode=1;});c.on('exit',code=>{if(!closing){stop();process.exitCode=code||0;}});}
console.log('医生网页：http://127.0.0.1:5173/doctor/；患者网页：http://127.0.0.1:5174/patient/；API：http://127.0.0.1:3200');
