import { reactive,onScopeDispose } from 'vue';
export const auth=reactive({account:null as any,csrfToken:'',loading:true,generation:0});
export class ApiError extends Error {
  constructor(message:string, public readonly status:number, public readonly code?:string){super(message);this.name='ApiError';}
}
export interface AuthScope {generation:number;accountId:string|null;csrfToken:string}
export const authScope=():AuthScope=>({generation:auth.generation,accountId:auth.account?.id||null,csrfToken:auth.csrfToken});
export const isCurrentAuth=(scope:AuthScope)=>scope.generation===auth.generation&&scope.accountId===(auth.account?.id||null)&&scope.csrfToken===auth.csrfToken;
const staleAuth=()=>new ApiError('登录状态已改变，已忽略上一次请求。',0,'STALE_AUTH');
export function assertCurrentAuth(scope:AuthScope){if(!isCurrentAuth(scope))throw staleAuth();}
export const isStaleAuthError=(error:unknown)=>error instanceof ApiError&&error.code==='STALE_AUTH';
function clearAuth(){auth.account=null;auth.csrfToken='';++auth.generation;}
function acceptAuth(session:{account:any;csrfToken?:string}){auth.csrfToken=session.csrfToken||'';auth.account=session.account;++auth.generation;}
export async function api<T=any>(path:string,method='GET',body?:unknown):Promise<T>{
  const scope=authScope();
  if(body===undefined&&['POST','PUT','PATCH'].includes(method))body={};
  let response:Response;let data:any;
  try{
    response=await fetch('/api/v1'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(scope.csrfToken?{'x-csrf-token':scope.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    data=await response.json().catch(()=>({}));
  }catch(error){assertCurrentAuth(scope);throw error;}
  assertCurrentAuth(scope);
  if(!response.ok){if(response.status===401&&path!=='/auth/clinician/login')clearAuth();throw new ApiError(data.error?.message||'请求未完成，请稍后重试',response.status,data.error?.code);}return data;
}
// Bind workspace actions to their mounted login lifetime, including continuations
// after dialogs and navigation. An old component cannot issue a new-account request.
export function useAuthApi(){
  const scope=authScope();let active=true;
  onScopeDispose(()=>{active=false;});
  return async<T=any>(path:string,method='GET',body?:unknown):Promise<T>=>{
    if(!active)throw staleAuth();assertCurrentAuth(scope);
    const result=await api<T>(path,method,body);
    if(!active)throw staleAuth();assertCurrentAuth(scope);return result;
  };
}
export async function login(username:string,password:string){
  ++auth.generation;const scope=authScope();
  const session=await api('/auth/clinician/login','POST',{username,password});assertCurrentAuth(scope);acceptAuth(session);
}
export async function logout(){
  ++auth.generation;const scope=authScope();
  await api('/auth/logout','POST');assertCurrentAuth(scope);clearAuth();
}
export async function restoreAuth(){
  ++auth.generation;const scope=authScope();
  try{const session=await api('/auth/session');assertCurrentAuth(scope);acceptAuth(session);auth.loading=false;}
  catch{if(isCurrentAuth(scope)||!auth.account)auth.loading=false;}
}
export const dateTime=(value:any)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'—';
export const fullDate=(value:any)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)):'—';
export const taskLabel=(s:string)=>({pending:'待随访',in_progress:'进行中',submitted:'待审核',reviewed:'已审核',cancelled:'已取消'}[s]||s);
export const roleName=(s:string)=>({dialogue:'对话采集',knowledge:'证据复核',safety:'安全检查',judge:'综合整理'}[s]||s);
