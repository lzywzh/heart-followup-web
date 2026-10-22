<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue';
import {useAuthApi,isStaleAuthError,ApiError} from '../api';
const api=useAuthApi();

interface AccountStatus {enabled:boolean;username:string|null;mustChangePassword:boolean}
interface Credentials {username:string;temporaryPassword:string}
const props=defineProps<{patientId:string;patientName:string}>();
const emit=defineEmits(['changed']);
const status=ref<AccountStatus|null>(null);
const loading=ref(true);
const busy=ref(false);
const error=ref('');
const formError=ref('');
const editOpen=ref(false);
const username=ref('');
// Credentials exist only in this mounted component and are cleared on dismissal.
const credentials=ref<Credentials|null>(null);
const patientUrl=new URL('/patient/',window.location.origin).href;
const hasAccount=computed(()=>Boolean(status.value?.username));
const usernameValid=computed(()=>/^[A-Za-z0-9_.-]{3,80}$/.test(username.value));
let mounted=true;let refreshRequest=0;

function accountError(cause:unknown){
  if(cause instanceof ApiError&&(cause.status===403||cause.status===404))return '仅负责该患者的医生可以查看或管理网页账号，请确认档案归属。';
  return cause instanceof Error?cause.message:'请求未完成，请稍后重试';
}
async function refresh(){
  const request=++refreshRequest;loading.value=true;error.value='';
  try{const result=await api<AccountStatus>(`/clinician/patients/${props.patientId}/web-account`);if(mounted&&request===refreshRequest)status.value=result;}
  catch(cause){if(mounted&&request===refreshRequest&&!isStaleAuthError(cause)){status.value=null;error.value=accountError(cause);}}
  finally{if(mounted&&request===refreshRequest)loading.value=false;}
}
function open(){username.value=status.value?.username||'';formError.value='';editOpen.value=true;}
async function provision(){
  if(busy.value)return;
  if(!usernameValid.value){formError.value='账号需为 3–80 位，仅可使用英文字母、数字、下划线、短横线和英文句点。';return;}
  busy.value=true;formError.value='';
  try{
    const result=await api<Credentials>(`/clinician/patients/${props.patientId}/web-account`,'POST',{username:username.value});
    if(!mounted)return;
    editOpen.value=false;
    credentials.value=result;
    status.value={enabled:true,username:result.username,mustChangePassword:true};
    emit('changed');
  }catch(cause){if(mounted&&!isStaleAuthError(cause))formError.value=accountError(cause)+' 若请求中断，请先刷新账号状态；需要新的初始密码时，再明确重置。';}
  finally{if(mounted)busy.value=false;}
}
function dismissCredentials(){credentials.value=null;}
function beforeClose(done:()=>void){if(!busy.value)done();}
onMounted(refresh);
onUnmounted(()=>{mounted=false;dismissCredentials();});
</script>

<template>
  <div class="detail-section web-account-panel" aria-labelledby="web-account-heading">
    <h3 id="web-account-heading">患者网页账号</h3>
    <p v-if="loading" class="muted" role="status">正在查询账号状态…</p>
    <template v-else-if="error">
      <p class="account-error" role="alert">{{error}}</p>
      <el-button size="small" @click="refresh">重试查询</el-button>
    </template>
    <template v-else-if="status">
      <dl class="key-values">
        <dt>账号状态</dt><dd><span class="status" :class="status.enabled?'green':'gray'">{{status.enabled?'已开通':hasAccount?'已停用':'尚未开通'}}</span></dd>
        <template v-if="hasAccount"><dt>登录账号</dt><dd>{{status.username}}</dd><dt>密码状态</dt><dd>{{status.mustChangePassword?'患者登录后需修改初始密码':'患者已设置密码'}}</dd></template>
        <dt>患者入口</dt><dd><a :href="patientUrl" target="_blank" rel="noopener noreferrer" class="patient-web-link">{{patientUrl}} ↗</a></dd>
      </dl>
      <p class="muted">核对患者身份后，将账号和初始密码单独交给本人。已有档案会沿用同一个患者账户。</p>
      <el-button :type="hasAccount?'default':'primary'" size="small" @click="open">{{hasAccount?'重置初始密码':'开通网页账号'}}</el-button>
      <el-button text size="small" @click="refresh">刷新状态</el-button>
    </template>
  </div>

  <el-dialog v-model="editOpen" :title="hasAccount?'重置患者初始密码':'开通患者网页账号'" width="500px" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="beforeClose" destroy-on-close>
    <p>患者：<strong>{{patientName}}</strong></p>
    <p v-if="hasAccount" class="notice-card">重置后，患者原密码及当前登录会话将失效。请先核对本人身份；患者需使用新的初始密码登录并修改密码。</p>
    <el-form label-position="top" @submit.prevent="provision">
      <el-form-item label="患者登录账号" for="patient-web-username" :error="formError">
        <el-input id="patient-web-username" v-model="username" :disabled="busy" maxlength="80" autocomplete="off" placeholder="填写患者使用的账号"/>
      </el-form-item>
      <p class="muted">3–80 位，支持英文字母、数字、下划线、短横线和英文句点。初始密码由系统生成。</p>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="editOpen=false">取消</el-button><el-button type="primary" :loading="busy" @click="provision">{{hasAccount?'确认重置初始密码':'确认开通'}}</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!credentials" @update:model-value="!$event&&dismissCredentials()" title="患者网页登录凭据" width="500px" destroy-on-close>
    <template v-if="credentials">
      <p class="notice-card">账号已为 {{patientName}} 准备好。初始密码仅在本次显示，关闭后无法再次查看。请单独交给患者本人。</p>
      <dl class="key-values credential-values"><dt>患者入口</dt><dd><a :href="patientUrl" target="_blank" rel="noopener noreferrer" class="patient-web-link">{{patientUrl}}</a></dd><dt>登录账号</dt><dd>{{credentials.username}}</dd><dt>初始密码</dt><dd><code data-testid="temporary-password">{{credentials.temporaryPassword}}</code></dd></dl>
      <p class="muted">患者首次登录后必须修改密码。如未保存，请通过“重置初始密码”生成新的凭据。</p>
    </template>
    <template #footer><el-button type="primary" @click="dismissCredentials">已交付，关闭凭据</el-button></template>
  </el-dialog>
</template>

<style scoped>
.web-account-panel>p{font-size:12px;margin:15px 0}.patient-web-link{color:#14796f;overflow-wrap:anywhere}.account-error{color:#b65c4e}.credential-values{grid-template-columns:85px minmax(0,1fr);font-size:13px;margin:22px 0}.credential-values code{font-size:17px;color:#1b6358;user-select:all;overflow-wrap:anywhere}.credential-values+p{font-size:12px}.web-account-panel .key-values{grid-template-columns:80px minmax(0,1fr)}
</style>
