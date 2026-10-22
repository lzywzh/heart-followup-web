<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,shallowRef,watch} from 'vue';
import {api,auth,authScope,assertCurrentAuth,isCurrentAuth,isStaleAuthError,capabilities,changePassword,dateTime,login,logout,restoreAuth,speechAudio,statusLabel,voiceApi,workspace,type AuthScope} from './api.js';
import type {Capabilities,Session,Workspace} from './types.js';
import {VoiceController,type VoiceState} from './voice/controller.js';
import {PcmRecorder} from './voice/recorder.js';
import {BrowserSpeaker} from './voice/speaker.js';
const tab=ref('home'),busy=ref(false),loading=ref(false),error=ref(''),notice=ref('');
const username=ref(''),password=ref(''),currentPassword=ref(''),newPassword=ref(''),confirmPassword=ref('');
const data=ref<Workspace|null>(null),call=ref(false),selected=ref<Session|null>(null),caps=ref<Capabilities|null>(null);
const contact=ref({phone:'',emergencyContact:'',emergencyPhone:'',personalNotes:''});
const view=shallowRef<{state:VoiceState;session?:Session;error:string;level:number;lastText:string}>({state:'ready',error:'',level:0,lastText:''});
const speaker=new BrowserSpeaker(speechAudio);
const controller=new VoiceController({recorder:new PcmRecorder(),speaker,api:voiceApi,uuid:()=>crypto.randomUUID(),changed:()=>{view.value={state:controller.state,session:controller.session,error:controller.error,level:controller.level,lastText:controller.lastText};}});
const nextTask=computed(()=>data.value?.tasks.find(t=>['pending','in_progress'].includes(t.status)));
const readyTask=computed(()=>data.value?.tasks.find(t=>t.available&&['pending','in_progress'].includes(t.status)));
const availableTasks=computed(()=>data.value?.tasks.filter(t=>!['cancelled','reviewed'].includes(t.status))||[]);
const stateLabel:Record<VoiceState,string>={ready:'准备开始',authorizing:'正在准备麦克风',speaking:'请听助手说话',listening:'正在听您说话',processing:'正在识别与整理',paused:'通话已暂停',ending:'正在保存本次随访',ended:'本次通话已结束',error:'需要您的操作'};
const descriptions:Record<VoiceState,string>={ready:'在安静的地方坐好，允许麦克风后开始。',authorizing:'请允许浏览器使用麦克风，并保持页面在前台。',speaking:'播报时麦克风已关闭，听完后直接回答即可。',listening:'像平时聊天一样回答，停顿片刻会自动结束这一句。',processing:'请稍候，您的回答正在保存。',paused:'已保存的回答会保留，未说完的这一句需要重新回答。',ending:'正在等待最后一句处理完成，请保持页面打开。',ended:'随访采集记录已保存，医生审核后会在这里反馈。',error:'记录会保留，恢复后可继续本次随访。'};
const inCall=computed(()=>call.value&&!['ready','ended','paused','error'].includes(view.value.state));
let actionSequence=0,loadSequence=0;
async function action(fn:(scope:AuthScope)=>Promise<unknown>,authAction=false){
  if(busy.value)return;const sequence=++actionSequence,scope=authScope();busy.value=true;error.value='';notice.value='';
  try{await fn(scope);}catch(e){if(sequence===actionSequence&&!isStaleAuthError(e)&&(authAction||isCurrentAuth(scope)))error.value=e instanceof Error?e.message:'操作未完成，请重试。';}
  finally{if(sequence===actionSequence)busy.value=false;}
}
async function load(){
  const sequence=++loadSequence,scope=authScope();loading.value=true;
  try{const result=await workspace();assertCurrentAuth(scope);if(sequence!==loadSequence)return;data.value=result;if(result.patient){const p=result.patient;contact.value={phone:p.phone||'',emergencyContact:p.emergencyContact||'',emergencyPhone:p.emergencyPhone||'',personalNotes:p.personalNotes||''};}}
  catch(e){if(sequence===loadSequence&&isCurrentAuth(scope)&&!isStaleAuthError(e))error.value=e instanceof Error?e.message:'加载失败';}
  finally{if(sequence===loadSequence&&isCurrentAuth(scope))loading.value=false;}
}
function signIn(){void action(async()=>{await login(username.value.trim(),password.value);},true);}
function updatePassword(){void action(async()=>{if(newPassword.value!==confirmPassword.value)throw new Error('两次新密码不一致。');const scope=await changePassword(currentPassword.value,newPassword.value);assertCurrentAuth(scope);notice.value='密码已更新。';},true);}
async function openCall(taskId?:string){await action(async(scope)=>{
  const result=await capabilities();assertCurrentAuth(scope);caps.value=result;if(!caps.value.ready||!caps.value.asr)throw new Error(caps.value.message||'语音识别暂不可用，请稍后重试。');
  speaker.mode=caps.value.ttsMode;
  const s=data.value?.activeSession?await voiceApi.get(data.value.activeSession.id):await api<Session>('/followups','POST',{clientRequestId:crypto.randomUUID(),...(taskId?{taskId}:{})});
  assertCurrentAuth(scope);
  controller.dispose();controller.session=s;controller.state=['submitted','handoff'].includes(s.status)?'ended':'ready';controller.error='';
  view.value={state:controller.state,session:s,error:'',level:0,lastText:''};call.value=true;
});}
function begin(){if(!view.value.session)return;void controller.start(view.value.session);}
async function closeCall(){if(inCall.value||view.value.state==='ending')return;controller.dispose();call.value=false;await load();}
async function doLogout(){await action(async()=>{await logout();},true);}
function saveContact(){void action(async(scope)=>{await api('/me/contact','PATCH',{...contact.value});assertCurrentAuth(scope);await load();assertCurrentAuth(scope);notice.value='联系信息已保存。';});}
function historyDetail(id:string){void action(async(scope)=>{const session=await voiceApi.get(id);assertCurrentAuth(scope);selected.value=session;});}
function background(){if(document.visibilityState==='hidden'&&call.value&&inCall.value)void controller.pause();}
function pageLeave(event:BeforeUnloadEvent){if(inCall.value){event.preventDefault();event.returnValue='';}}
watch(()=>[auth.generation,auth.account?.id,auth.account?.mustChangePassword] as const,(current,previous)=>{
  ++loadSequence;controller.dispose();controller.session=undefined;call.value=false;data.value=null;selected.value=null;caps.value=null;loading.value=false;error.value='';notice.value='';
  contact.value={phone:'',emergencyContact:'',emergencyPhone:'',personalNotes:''};password.value='';currentPassword.value='';newPassword.value='';confirmPassword.value='';
  view.value={state:'ready',error:'',level:0,lastText:''};tab.value='home';
  if(current[1]!==previous?.[1]){++actionSequence;busy.value=false;}
  if(auth.account&&!auth.account.mustChangePassword)void load();
},{flush:'sync'});
onMounted(()=>{void restoreAuth();document.addEventListener('visibilitychange',background);window.addEventListener('beforeunload',pageLeave);});
onBeforeUnmount(()=>{controller.dispose();document.removeEventListener('visibilitychange',background);window.removeEventListener('beforeunload',pageLeave);});
</script>

<template>
  <div v-if="auth.loading" class="loading-page" role="status"><span class="brand-icon">♡</span><p>正在打开您的随访服务…</p></div>
  <div v-else-if="!auth.account" class="login-page">
    <section class="login-story">
      <div class="brand light"><span class="brand-icon">♡</span><div>心伴随访<small>HEART · FOLLOW-UP</small></div></div>
      <div class="story-copy"><span class="eyebrow">每一次倾听，都是陪伴</span><h1>把日常的变化，<br>慢慢说给我们听。</h1><p>用熟悉的声音，完成一次轻松的随访。<br>让您的健康变化，被认真记录。</p>
        <svg class="heart-line" viewBox="0 0 500 120" aria-hidden="true"><path d="M0 65 H130 L148 40 L169 90 L197 10 L227 110 L249 65 H500"/></svg>
      </div><p class="story-foot"><span class="dot"></span> 您的随访记录，仅您与负责医生可查看</p>
    </section>
    <main class="login-form"><form class="login-box" @submit.prevent="signIn">
      <div class="mobile-brand brand"><span class="brand-icon">♡</span><div>心伴随访<small>患者服务</small></div></div>
      <span class="eyebrow">PATIENT CARE</span><h2>欢迎回来</h2><p class="muted">登录后，开始今天的健康随访。</p>
      <label>患者账号<input v-model="username" name="username" autocomplete="username" required maxlength="80" placeholder="请输入医生为您开通的账号"></label>
      <label>密码<input v-model="password" name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"></label>
      <p v-if="error" class="error" role="alert">{{error}}</p><button class="primary wide" :disabled="busy">{{busy?'正在登录…':'登录患者服务'}} <span>→</span></button>
      <p class="login-help">账号由负责医生开通。忘记密码时，请联系医生重置。</p><a class="doctor-link" href="/doctor/">医生工作台 ↗</a>
    </form></main>
  </div>
  <div v-else-if="auth.account.mustChangePassword" class="password-page"><form class="card password-card" @submit.prevent="updatePassword"><span class="brand-icon">♡</span><span class="eyebrow">ACCOUNT SECURITY</span><h1>设置您的新密码</h1><p class="muted">首次登录，请将医生提供的初始密码更换为您自己的密码。</p><label>初始密码<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="128" placeholder="至少 10 个字符"></label><label>再次输入新密码<input v-model="confirmPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="128"></label><p v-if="error" class="error" role="alert">{{error}}</p><button class="primary wide" :disabled="busy">{{busy?'正在保存…':'保存并进入服务'}}</button><button type="button" class="text-button" :disabled="busy" @click="doLogout">退出登录</button></form></div>
  <div v-else class="app-shell">
    <header class="site-header"><div class="header-inner"><a class="brand" href="/patient/"><span class="brand-icon">♡</span><div>心伴随访<small>患者服务 · PATIENT CARE</small></div></a><div class="account"><span class="avatar">{{(data?.patient?.name||auth.account.displayName||'您').slice(-1)}}</span><span>{{data?.patient?.name||auth.account.displayName}}</span><button class="text-button" :disabled="busy||inCall" @click="doLogout">退出</button></div></div></header>
    <nav v-if="!call" class="main-nav" aria-label="患者服务导航"><button v-for="item in [{id:'home',name:'我的随访'},{id:'records',name:'健康档案'},{id:'history',name:'历史记录'},{id:'profile',name:'联系信息'}]" :key="item.id" :class="{active:tab===item.id}" @click="tab=item.id;selected=null;error='';notice=''">{{item.name}}</button></nav>
    <main class="content" :class="{'call-content':call}">
      <p v-if="error" class="error" role="alert">{{error}} <button class="text-button" :disabled="busy||loading" @click="load">重新加载</button></p><p v-if="notice" class="success" role="status">{{notice}}</p>
      <template v-if="call">
        <div class="call-heading"><div><span class="eyebrow">VOICE FOLLOW-UP</span><h1>一次安心的健康对话</h1></div><button v-if="!inCall&&view.state!=='ending'" class="text-button" @click="closeCall">返回我的随访 ↗</button></div>
        <div v-if="view.session?.requiresHumanReview" class="urgent" role="alert">如果您有严重胸闷、呼吸困难、晕厥等不适，请立即联系当地急救或及时就医。此页面不能代替急救，也不会自动通知医生。</div>
        <section v-if="view.state==='ended'" class="card summary-card"><span class="result-icon">✓</span><span class="eyebrow">FOLLOW-UP SAVED</span><h2>{{view.session?.briefSummary?.title||'本次随访记录'}}</h2><p class="muted">采集记录已保存，等待负责医生审核。</p><dl v-if="view.session?.briefSummary" class="summary-list"><div v-for="(item,index) in view.session.briefSummary.items" :key="index"><dt>{{item.label}}</dt><dd>{{item.value}}</dd></div></dl><p class="summary-note">{{view.session?.briefSummary?.note||'本次采集内容尚未由医生审核，不作为医生诊断。未采集的内容不会视为正常。'}}</p><p v-if="view.session?.feedback" class="feedback"><strong>医生反馈</strong>{{view.session.feedback}}</p><button class="primary" @click="closeCall">返回我的随访</button></section>
        <section v-else class="card voice-card">
          <div class="voice-mode"><span class="dot"></span>{{caps?.ttsMode==='server'?'服务器中文语音播报':caps?.ttsMode==='browser'?'设备中文语音播报':'云端语音播报'}}<span>麦克风仅在聆听时开启</span></div>
          <div class="voice-orb" :class="view.state" aria-hidden="true"><div class="orb-ring"></div><div class="orb-core"><svg viewBox="0 0 64 64"><path d="M10 32h10l5-13 9 26 7-18 4 5h9"/></svg></div></div>
          <div class="call-state" role="status" aria-live="polite"><span class="eyebrow">{{view.state==='listening'?'WE ARE LISTENING':'HERE WITH YOU'}}</span><h2>{{stateLabel[view.state]}}</h2><p>{{descriptions[view.state]}}</p></div>
          <div v-if="view.state==='listening'" class="level" role="meter" aria-label="麦克风音量" :aria-valuenow="Math.round(view.level*100)" aria-valuemin="0" aria-valuemax="100"><i v-for="n in 25" :key="n" :class="{on:n/25<=view.level}" :style="{height:(10+Math.sin(n*2)*6+Math.cos(n)*9+12)+'px'}"></i></div>
          <p v-if="view.lastText" class="current-question">{{view.lastText}}</p>
          <p v-if="view.error" class="error" role="alert">{{view.error}}</p>
          <div v-if="view.state==='ready'" class="start-call"><button class="primary large" @click="begin">开启麦克风，开始随访 <span>→</span></button><p>{{caps?.ttsMode==='browser'?'开始后将使用当前设备的中文声音，请开启媒体音量。':'请开启媒体音量。助手说完后，直接回答即可。'}}</p></div>
          <div v-else class="call-controls"><button v-if="view.state==='listening'" class="primary" @click="controller.finishSentence()">我说完这一句了</button><button v-if="view.state==='speaking'" class="primary" @click="controller.interrupt()">打断，我来说</button><button v-if="['listening','speaking'].includes(view.state)" class="secondary" @click="controller.replay()">重复上一句</button><button v-if="['paused','error'].includes(view.state)" class="primary" @click="controller.resume()">{{view.state==='paused'?'继续通话':'重试 / 恢复'}}</button><button v-if="!['paused','ending'].includes(view.state)" class="secondary" @click="controller.pause()">暂停</button><button class="end-button" :disabled="view.state==='ending'||view.state==='authorizing'" @click="controller.end()">{{view.state==='ending'?'正在保存…':'结束通话'}}</button></div>
          <p class="voice-foot">停顿约一秒自动结束一句 · 每句最多 24 秒<br>切换到后台会暂停，请回到页面后手动继续。</p>
        </section>
      </template>
      <template v-else-if="loading&&!data"><div class="card empty" role="status">正在加载您的档案…</div></template>
      <template v-else-if="!data?.patient"><div class="card empty"><span class="empty-icon">♡</span><h2>等待医生完善档案</h2><p>账号尚未关联健康档案，请联系负责医生。</p><button class="secondary" @click="load">刷新档案</button></div></template>
      <template v-else-if="tab==='home'">
        <div class="page-heading"><span class="eyebrow">YOUR HEALTH, TOGETHER</span><h1>{{data.patient.name}}，您好。</h1><p>今天感觉怎么样？让我们一起关注每一点变化。</p></div>
        <div class="home-grid"><section class="hero-card"><div class="hero-copy"><span class="hero-tag">语音随访 · 轻松完成</span><h2>{{data.activeSession?'继续上次的健康对话':readyTask?'今天，和我们说说近况':'每一份近况，都值得关心'}}</h2><p>听一听，聊一聊。<br>您的回答会整理为简短记录，交给负责医生审核。</p><button class="primary" :disabled="busy||(!data.activeSession&&!readyTask)" @click="openCall(readyTask?.id)">{{busy?'正在准备…':data.activeSession?'继续语音随访':readyTask?'开始语音随访':'等待随访开放'}} <span>→</span></button><small>{{data.activeSession?'上次记录已保留，可继续完成':readyTask?'请在安静的环境中使用麦克风':nextTask?'下次安排：'+dateTime(nextTask.scheduled_at):'医生安排随访后，会显示在这里'}}</small></div><div class="hero-art" aria-hidden="true"><div class="art-circle"><span>♡</span></div><div class="art-label">用声音，连接关怀</div><i class="art-dot one"></i><i class="art-dot two"></i></div></section><section class="card care-card"><span class="small-icon">✧</span><h3>今天的小提醒</h3><p>按医生安排用药，留意体重和身体感受。没有测量或不确定的地方，直接说出来就好。</p><div class="care-divider"></div><small>如有明显不适，请及时就医。随访服务不能代替急救。</small></section></div>
        <div class="section-heading"><h2>我的随访安排</h2><span>{{availableTasks.length}} 项记录</span></div><section class="card task-list"><div v-if="!availableTasks.length" class="empty compact"><h3>目前没有待完成的安排</h3><p>有新的随访任务时，会显示在这里。</p></div><article v-for="task in availableTasks" :key="task.id" class="task-row"><div class="calendar-icon">{{new Date(task.scheduled_at).getDate()}}<small>日</small></div><div class="task-copy"><h3>{{task.title}}</h3><p>{{dateTime(task.scheduled_at)}} <span v-if="task.overdue&&['pending','in_progress'].includes(task.status)"> · 请尽快完成</span></p></div><span class="pill" :class="task.status">{{statusLabel(task.status)}}</span><button v-if="['pending','in_progress'].includes(task.status)" class="secondary" :disabled="busy||!task.available" @click="openCall(task.id)">{{task.available?'进入随访':'尚未开放'}}</button></article></section>
        <p class="privacy-note"><span>♧</span> 您的健康信息受到保护，仅用于随访服务。</p>
      </template>
      <template v-else-if="tab==='records'"><div class="page-heading"><span class="eyebrow">HEALTH RECORD</span><h1>我的健康档案</h1><p>由负责医生维护，帮助每次随访更了解您。</p></div><div class="record-layout"><section class="card identity-card"><div class="avatar large-avatar">{{data.patient.name.slice(-1)}}</div><h2>{{data.patient.name}}</h2><p>{{data.patient.sex==='male'?'男':data.patient.sex==='female'?'女':'性别未填写'}} · {{data.patient.birthDate||'出生日期未填写'}}</p><span class="pill">档案已关联</span></section><section class="card record-card"><article v-for="field in [{id:'diagnosis',label:'诊断信息'},{id:'history',label:'既往病史'},{id:'medications',label:'目前用药'},{id:'dischargeSummary',label:'出院记录'},{id:'carePlan',label:'照护计划'}]" :key="field.id"><h3>{{field.label}}</h3><p class="preserve">{{data.patient.medicalRecord?.[field.id]||'医生尚未填写'}}</p></article><p class="record-note">信息有变化或需要更正时，请联系负责医生。</p></section></div></template>
      <template v-else-if="tab==='history'"><div class="page-heading"><span class="eyebrow">FOLLOW-UP HISTORY</span><h1>每一次随访，都有记录</h1><p>查看采集总结与医生已发布的反馈。</p></div><section v-if="selected" class="card history-detail"><button class="text-button back" @click="selected=null">← 返回历史记录</button><h2>{{selected.briefSummary?.title||'随访记录'}}</h2><span class="pill">{{statusLabel(selected.status)}}</span><dl v-if="selected.briefSummary" class="summary-list"><div v-for="(item,index) in selected.briefSummary.items" :key="index"><dt>{{item.label}}</dt><dd>{{item.value}}</dd></div></dl><p v-else class="muted">本条较早记录尚无简短总结。</p><p class="summary-note">{{selected.briefSummary?.note||'采集内容不作为医生诊断。'}}</p><p v-if="selected.feedback" class="feedback"><strong>医生反馈</strong>{{selected.feedback}}</p><p v-else class="muted">医生反馈尚未发布。</p></section><section v-else class="card"><div v-if="!data.history.length" class="empty"><span class="empty-icon">◷</span><h3>还没有已完成的随访</h3><p>完成语音随访后，可在这里回看总结。</p></div><article v-for="item in data.history" :key="item.id" class="history-row"><div><span class="eyebrow">{{dateTime(item.started_at)}}</span><h3>{{item.briefSummary?.title||'健康随访'}}</h3><p>{{item.feedback?'医生反馈已发布':'等待医生审核与反馈'}}</p></div><span class="pill">{{statusLabel(item.status)}}</span><button class="secondary" :disabled="busy" @click="historyDetail(item.id)">查看记录 →</button></article></section></template>
      <template v-else-if="tab==='profile'"><div class="page-heading"><span class="eyebrow">STAY IN TOUCH</span><h1>保持联系，让关怀更近</h1><p>请保持您的联系电话与紧急联系人信息准确。</p></div><form class="card profile-card" @submit.prevent="saveContact"><h2>联系信息</h2><div class="form-grid"><label>您的联系电话<input v-model="contact.phone" type="tel" autocomplete="tel" maxlength="32"></label><label>紧急联系人<input v-model="contact.emergencyContact" autocomplete="off" maxlength="80"></label><label>紧急联系人电话<input v-model="contact.emergencyPhone" type="tel" maxlength="32"></label></div><label>个人备注<textarea v-model="contact.personalNotes" rows="3" maxlength="2000" placeholder="与您联系时需要注意的事项"></textarea></label><button class="primary" :disabled="busy">{{busy?'正在保存…':'保存联系信息'}}</button><p class="login-help">病历与用药由医生维护。此表单不用于提交随访回答或紧急求助。</p></form></template>
      <footer class="site-footer"><span>心伴随访 · 陪伴每一步康复</span><span>用心倾听，安心相伴</span></footer>
    </main>
  </div>
</template>
