import { reactive } from 'vue';
import type { Session, Workspace, Capabilities } from './types.js';
export const auth=reactive({account:null as {id:string;displayName:string;mustChangePassword?:boolean}|null,loading:true,generation:0});
let csrfToken='';
export class ApiError extends Error { constructor(message:string,public status:number,public code:string){super(message);} }
export interface AuthScope {generation:number;accountId:string|null}
export const authScope=():AuthScope=>({generation:auth.generation,accountId:auth.account?.id||null});
export const isCurrentAuth=(scope:AuthScope)=>scope.generation===auth.generation&&scope.accountId===(auth.account?.id||null);
export function assertCurrentAuth(scope:AuthScope){if(!isCurrentAuth(scope))throw new ApiError('登录状态已改变，已忽略上一次请求。',0,'STALE_AUTH');}
export const isStaleAuthError=(error:unknown)=>error instanceof ApiError&&error.code==='STALE_AUTH';
function clearAuth(){++auth.generation;csrfToken='';auth.account=null;}
export async function api<T=unknown>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const scope=authScope();
  const binary=body instanceof Blob;
  let response:Response;let data:any;
  try{
    response=await fetch('/api/v1/patient'+path,{method,credentials:'same-origin',headers:{...(body!==undefined?{'content-type':binary?'audio/wav':'application/json'}:{}),...(csrfToken?{'x-csrf-token':csrfToken}:{})},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)}),signal});
    data=await response.json().catch(()=>({}));
  }catch(error){assertCurrentAuth(scope);throw error;}
  assertCurrentAuth(scope);
  if(!response.ok){if(response.status===401&&path!=='/auth/login'&&data.error?.code!=='PASSWORD_INCORRECT')clearAuth();throw new ApiError(data.error?.message||'请求未完成，请检查网络后重试。',response.status,data.error?.code||'REQUEST_FAILED');}
  return data as T;
}
async function acceptAuth(path:string,body?:unknown){const scope=authScope();const s=await api<{account:NonNullable<typeof auth.account>;csrfToken:string}>(path,body?'POST':'GET',body);assertCurrentAuth(scope);csrfToken=s.csrfToken||'';auth.account=s.account;}
export async function restoreAuth(){const generation=++auth.generation;try{await acceptAuth('/auth/session');}catch{}finally{if(generation===auth.generation||!auth.account)auth.loading=false;}}
export async function login(username:string,password:string){++auth.generation;await acceptAuth('/auth/login',{username,password});auth.loading=false;}
export async function changePassword(currentPassword:string,newPassword:string){++auth.generation;const scope=authScope();await api('/auth/password','POST',{currentPassword,newPassword});assertCurrentAuth(scope);await acceptAuth('/auth/session');return authScope();}
export async function logout(){++auth.generation;const scope=authScope();await api('/auth/logout','POST',{});assertCurrentAuth(scope);clearAuth();}
export const workspace=()=>api<Workspace>('/me');
export const capabilities=()=>api<Capabilities>('/voice/capabilities');
export const voiceApi={
  get:(id:string)=>api<Session>('/followups/'+encodeURIComponent(id)),
  upload:(id:string,version:number,key:string,blob:Blob)=>api<{session:Session}>('/followups/'+encodeURIComponent(id)+'/audio?'+new URLSearchParams({expectedVersion:String(version),clientMessageId:key}),'POST',blob,AbortSignal.timeout(110000)),
  pause:(id:string)=>api<Session>('/followups/'+encodeURIComponent(id)+'/pause','POST',{}),
  resume:(id:string)=>api<Session>('/followups/'+encodeURIComponent(id)+'/resume','POST',{}),
  end:(id:string,version:number)=>api<Session>('/followups/'+encodeURIComponent(id)+'/end-call','POST',{expectedVersion:version}),
};
export async function speechAudio(session:Session,signal:AbortSignal){
  const scope=authScope();
  const response=await fetch('/api/v1/patient/followups/'+encodeURIComponent(session.id)+'/browser-speech',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify({expectedVersion:session.version}),signal});
  if(!response.ok){const data=await response.json().catch(()=>({}));assertCurrentAuth(scope);if(response.status===401)clearAuth();throw new Error(data.error?.message||'播报暂不可用，请重试。');}
  const audio=await response.blob();assertCurrentAuth(scope);return audio;
}
export const dateTime=(v:string)=>v?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'时间待安排';
export const statusLabel=(s:string)=>({pending:'待随访',in_progress:'进行中',active:'进行中',paused:'已暂停',awaiting_confirmation:'待结束',submitted:'待医生审核',reviewed:'已审核',handoff:'请及时就医',cancelled:'已取消'}[s]||s);
