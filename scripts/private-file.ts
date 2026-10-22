import { writeFile,mkdir,chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
export async function writePrivate(path:string,text:string|Uint8Array){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,text,{mode:0o600,flag:'wx'});
  if(process.platform==='win32')execFileSync('icacls.exe',[path,'/inheritance:r','/grant:r',userInfo().username+':F','SYSTEM:F'],{stdio:'ignore',windowsHide:true});
  else await chmod(path,0o600);
}
