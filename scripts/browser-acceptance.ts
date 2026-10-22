import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/modules/auth.js';
import { testDatabase } from '../apps/api/test/fixture.js';
import { testConfig } from '../apps/api/test/http-fixture.js';

// The fixture refuses non-*_test databases and creates a disposable PostgreSQL schema.
// All accounts, evidence and audio are synthetic. No production provider is contacted.
const serverSpeech=process.env.ACCEPTANCE_TTS_MODE==='server';
const output = serverSpeech?'.runtime/acceptance/server':'.runtime/acceptance';
const patientName = '浏览器验收患者';
const doctorUsername = 'acceptance-doctor';
const doctorPassword = 'BrowserAcceptance123!';
const patientUsername = 'acceptance-patient';
const patientPassword = 'PatientAcceptance456!';
const transcript = '最近走路呼吸还好，没有气短';
const doctorRoot = fileURLToPath(new URL('../apps/clinician-web/dist/', import.meta.url));
const patientRoot = fileURLToPath(new URL('../apps/patient-web/dist/', import.meta.url));
assert.ok(existsSync(doctorRoot) && existsSync(patientRoot), 'Build both websites before running test:ui');
await mkdir(output, { recursive: true });
await rm(`${output}/result.json`, { force: true });

const fixture = await testDatabase();
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let doctorPage: Page | undefined;
let patientPage: Page | undefined;
let sensitiveScreen = false;
let stage = 'initialization';
const errors: string[] = [];
let asrCalls = 0;
let uploadedWavBytes = 0;
let ttsCalls=0;
function playbackWav(){
  const bytes=Buffer.alloc(44+22050*2/2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(22050,24);bytes.writeUInt32LE(44100,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;
}

function responseFor(page: Page, suffix: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname.endsWith(suffix) && response.request().method() === method, { timeout: 15_000 });
}
async function successful(response: Promise<Response>, status: number) {
  const result = await response;
  assert.equal(result.status(), status, `${stage}: ${new URL(result.url()).pathname} returned HTTP ${result.status()}`);
  return result;
}
async function noOverflow(page: Page, label: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} has horizontal overflow`);
}
async function authStatus(page: Page, path: string) {
  return page.evaluate(async url => (await fetch(url, { credentials: 'same-origin' })).status, path);
}

try {
  const doctorId = randomUUID();
  await fixture.db.query("INSERT INTO accounts(id,role,display_name,login_name,password_hash) VALUES($1,'clinician','验收医生',$2,$3)", [doctorId, doctorUsername, await hashPassword(doctorPassword)]);
  app = await createApp({
    db: fixture.db,
    config: { ...testConfig, authMode: 'web', voiceTtsMode: serverSpeech?'server':'browser' },
    providers: {
      localTts:{status:async()=>({available:true}),synthesize:async(text:string)=>{assert.ok(text.trim());ttsCalls++;return playbackWav();}},
      localAsr: {
        status: async () => ({ available: true }),
        transcribe: async (bytes: Buffer) => {
          asrCalls++;
          uploadedWavBytes = bytes.length;
          assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'The browser must upload a WAV container');
          assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
          assert.equal(bytes.readUInt16LE(22), 1, 'The browser must record mono PCM');
          assert.equal(bytes.readUInt32LE(24), 16_000, 'The browser must resample to 16 kHz');
          assert.equal(bytes.readUInt16LE(34), 16, 'The browser must encode PCM16');
          assert.ok(bytes.length > 16_000, 'The upload must contain recorded samples');
          return transcript;
        },
      },
      dialogue: { nextTurn: async () => ({ facts: [{ field: 'breathing', evidence: transcript, status: 'reported' }], provider: 'acceptance', model: 'synthetic' }) },
    },
  });
  await app.register(fastifyStatic, { root: doctorRoot, prefix: '/doctor/' });
  await app.register(fastifyStatic, { root: patientRoot, prefix: '/patient/', decorateReply: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: process.env.ACCEPTANCE_BROWSER_CHANNEL || 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  context.setDefaultTimeout(15_000);
  // Real WebAudio, AudioWorklet and WAV encoding run. Only microphone hardware and
  // speech playback are replaced, so the test remains silent and reproducible.
  await context.addInitScript({ content: `(() => {
    const serverSpeech=${JSON.stringify(serverSpeech)};
    let speechTimer;
    if(serverSpeech){
      for(const name of ['speechSynthesis','SpeechSynthesisUtterance']){
        for(let owner=window;owner;owner=Object.getPrototypeOf(owner))if(Object.getOwnPropertyDescriptor(owner,name))Reflect.deleteProperty(owner,name);
      }
    }else{
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ lang: 'zh-CN', name: 'Synthetic Chinese acceptance voice', default: true, localService: true }],
      resume() {}, cancel() { clearTimeout(speechTimer); },
      speak(utterance) { speechTimer = setTimeout(() => utterance.onend?.(new Event('end')), 300); },
      addEventListener() {}, removeEventListener() {}
    }});
    }
    let micContext, gain;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      micContext = new AudioContext();
      const oscillator = micContext.createOscillator();
      oscillator.frequency.value = 220;
      gain = micContext.createGain(); gain.gain.value = 0;
      const destination = micContext.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      await micContext.resume();
      return destination.stream;
    }});
    window.__acceptanceSpeak = () => {
      if (!gain || !micContext) throw new Error('Synthetic microphone not ready');
      const at = micContext.currentTime;
      gain.gain.setValueAtTime(0.18, at);
      gain.gain.setValueAtTime(0, at + 0.7);
    };
  })();` });
  doctorPage = await context.newPage();
  patientPage = await context.newPage();
  for (const page of [doctorPage, patientPage]) page.on('pageerror', error => errors.push(error.message));

  stage = 'doctor login and patient creation';
  await doctorPage.goto(`${base}/doctor/`, { waitUntil: 'networkidle' });
  await doctorPage.getByLabel('账号', { exact: true }).fill(doctorUsername);
  await doctorPage.getByLabel('密码', { exact: true }).fill(doctorPassword);
  await doctorPage.getByRole('button', { name: '登录工作台', exact: true }).click();
  await doctorPage.getByRole('button', { name: '刷新数据', exact: true }).click();
  assert.equal(await authStatus(doctorPage, '/api/v1/auth/session'), 200, 'Doctor-only refresh must preserve login without a patient cookie');
  await doctorPage.getByRole('button', { name: '患者管理', exact: true }).click();
  await doctorPage.getByRole('button', { name: '新建患者', exact: true }).click();
  await doctorPage.getByLabel('患者姓名', { exact: true }).fill(patientName);
  await doctorPage.getByLabel('出生日期', { exact: true }).fill('1960-01-01');
  const created = responseFor(doctorPage, '/clinician/patients');
  await doctorPage.getByRole('button', { name: '保存并建档', exact: true }).click();
  const patientId = (await (await successful(created, 201)).json()).id as string;
  await doctorPage.getByRole('heading', { name: patientName, exact: true }).waitFor();

  stage = 'provision patient web account';
  await doctorPage.getByRole('button', { name: '开通网页账号', exact: true }).click();
  await doctorPage.locator('#patient-web-username').fill(patientUsername);
  const provisioned = responseFor(doctorPage, `/clinician/patients/${patientId}/web-account`);
  sensitiveScreen = true;
  await doctorPage.getByRole('button', { name: '确认开通', exact: true }).click();
  await successful(provisioned, 200);
  const temporaryPassword = await doctorPage.getByTestId('temporary-password').innerText();
  assert.ok(temporaryPassword.length >= 10, 'The one-time password must be present');
  await doctorPage.getByRole('button', { name: '已交付，关闭凭据', exact: true }).click();
  await doctorPage.getByTestId('temporary-password').waitFor({ state: 'detached' });
  sensitiveScreen = false;

  stage = 'doctor medical record and schedule';
  await doctorPage.getByRole('button', { name: '维护病历', exact: true }).click();
  await doctorPage.getByLabel('诊断记录', { exact: true }).fill('仅用于自动化验收的合成档案');
  const medicalSaved = responseFor(doctorPage, `/clinician/patients/${patientId}/medical-record`, 'PUT');
  await doctorPage.getByRole('button', { name: '保存病历', exact: true }).click();
  await successful(medicalSaved, 200);
  await doctorPage.getByRole('button', { name: '安排随访', exact: true }).click();
  const scheduled = new Date(Date.now() + 3_600_000);
  const local = new Date(scheduled.getTime() - scheduled.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await doctorPage.getByLabel('随访时间', { exact: true }).fill(local);
  const taskSaved = responseFor(doctorPage, '/clinician/tasks');
  await doctorPage.getByRole('button', { name: '保存安排', exact: true }).click();
  const taskId = (await (await successful(taskSaved, 201)).json()).id as string;

  stage = 'patient login and forced password replacement';
  await patientPage.goto(`${base}/patient/`, { waitUntil: 'networkidle' });
  if(serverSpeech)assert.equal(await patientPage.evaluate(()=>typeof window.speechSynthesis),'undefined','The server-audio journey must work without SpeechSynthesis');
  await patientPage.getByLabel('患者账号', { exact: true }).fill(patientUsername);
  await patientPage.getByLabel('密码', { exact: true }).fill(temporaryPassword);
  await patientPage.getByRole('button', { name: /登录患者服务/ }).click();
  await patientPage.getByRole('heading', { name: '设置您的新密码', exact: true }).waitFor();
  assert.equal(await authStatus(patientPage, '/api/v1/patient/me'), 403, 'Initial-password session must not access patient records');
  await patientPage.getByLabel('初始密码', { exact: true }).fill(temporaryPassword);
  await patientPage.getByLabel('新密码', { exact: true }).fill(patientPassword);
  await patientPage.getByLabel('再次输入新密码', { exact: true }).fill(patientPassword);
  await patientPage.getByRole('button', { name: '保存并进入服务', exact: true }).click();
  await patientPage.getByRole('heading', { name: `${patientName}，您好。`, exact: true }).waitFor();
  await patientPage.getByRole('button', { name: '健康档案', exact: true }).click();
  await patientPage.getByText('仅用于自动化验收的合成档案', { exact: true }).waitFor();
  await patientPage.getByRole('button', { name: '我的随访', exact: true }).click();
  assert.equal(await authStatus(doctorPage, '/api/v1/auth/session'), 200, 'Patient login must preserve the doctor cookie');
  assert.equal(await authStatus(patientPage, '/api/v1/patient/auth/session'), 200);

  stage = 'voice-only call with real browser WAV upload';
  await patientPage.getByRole('button', { name: /开始语音随访/ }).click();
  await patientPage.getByRole('heading', { name: '一次安心的健康对话', exact: true }).waitFor();
  assert.equal(await patientPage.locator('input,textarea,[contenteditable="true"]').count(), 0, 'The call must not offer typed chat');
  await patientPage.setViewportSize({ width: 390, height: 844 });
  await noOverflow(patientPage, 'patient mobile call');
  await patientPage.screenshot({ path: `${output}/patient-call-mobile.png`, fullPage: true });
  await patientPage.getByRole('button', { name: /开启麦克风，开始随访/ }).click();
  await patientPage.getByRole('heading', { name: '正在听您说话', exact: true }).waitFor();
  const audioSaved = patientPage.waitForResponse(response => /\/patient\/followups\/[^/]+\/audio\?/.test(response.url()) && response.request().method() === 'POST', { timeout: 20_000 });
  await patientPage.evaluate(() => (window as any).__acceptanceSpeak());
  const audio = await successful(audioSaved, 200);
  const session = (await audio.json()).session;
  assert.equal(asrCalls, 1, 'Automatic end-of-speech must create exactly one recognition operation');
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].patientText, transcript);
  assert.equal(session.turns[0].source, 'voice');
  // End while the reply is still processing/playing. The controller must retain the answer.
  const callEnded = responseFor(patientPage, `/patient/followups/${session.id}/end-call`);
  await patientPage.getByRole('button', { name: '结束通话', exact: true }).click();
  const ended = await (await successful(callEnded, 200)).json();
  assert.equal(ended.status, 'submitted');
  assert.equal(ended.patientConfirmed, false, 'An automated call must not fabricate explicit confirmation');
  await patientPage.locator('.summary-card').waitFor();
  const patientItems = await patientPage.locator('.summary-card .summary-list > div').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('dt')?.textContent, value: row.querySelector('dd')?.textContent })));
  assert.deepEqual(patientItems, ended.briefSummary.items);
  assert.ok(patientItems.some(item => item.value?.includes('呼吸还好')));
  assert.ok(patientItems.some(item => item.value === '本次未采集'), 'Missing information must remain missing');
  await noOverflow(patientPage, 'patient mobile summary');
  await patientPage.screenshot({ path: `${output}/patient-summary-mobile.png`, fullPage: true });
  await patientPage.getByRole('button', { name: '返回我的随访', exact: true }).click();
  await patientPage.getByRole('button', { name: '等待随访开放', exact: false }).waitFor();
  assert.equal(await patientPage.getByRole('button', { name: /开始语音随访/ }).count(), 0, 'A submitted task must not remain available to start');
  const task = (await fixture.db.query('SELECT status FROM followup_tasks WHERE id=$1', [taskId])).rows[0];
  assert.equal(task.status, 'submitted');
  await patientPage.getByRole('button', { name: '历史记录', exact: true }).click();
  await patientPage.getByRole('button', { name: /查看记录/ }).click();
  await patientPage.locator('.history-detail .summary-list > div').first().waitFor();
  const historyItems = await patientPage.locator('.history-detail .summary-list > div').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('dt')?.textContent, value: row.querySelector('dd')?.textContent })));
  assert.deepEqual(historyItems, patientItems);

  stage = 'doctor shared summary and feedback';
  await doctorPage.getByRole('button', { name: '随访审核', exact: true }).click();
  await doctorPage.getByRole('button', { name: '刷新数据', exact: true }).click();
  await doctorPage.getByRole('button', { name: '查看并审核', exact: true }).click();
  await doctorPage.locator('#shared-brief-title').waitFor();
  const doctorItems = await doctorPage.locator('.shared-brief .brief-items').evaluate(dl => [...dl.querySelectorAll('dt')].map(dt => ({ label: dt.textContent, value: dt.nextElementSibling?.textContent })));
  assert.deepEqual(doctorItems, patientItems, 'Doctor and patient must receive the same brief summary');
  await doctorPage.getByLabel('患者可见反馈', { exact: true }).fill('已核对本次软件验收记录。');
  const reviewed = responseFor(doctorPage, `/clinician/followups/${session.id}/review`);
  await doctorPage.getByRole('button', { name: '审核并发布反馈', exact: true }).click();
  await successful(reviewed, 200);
  await doctorPage.screenshot({ path: `${output}/doctor-shared-summary-desktop.png`, fullPage: true });
  await patientPage.reload({ waitUntil: 'networkidle' });
  await patientPage.getByRole('button', { name: '历史记录', exact: true }).click();
  await patientPage.getByRole('button', { name: /查看记录/ }).click();
  await patientPage.locator('.feedback').filter({ hasText: '已核对本次软件验收记录。' }).waitFor();

  stage = 'independent logout and mobile layouts';
  await doctorPage.setViewportSize({ width: 390, height: 844 });
  await noOverflow(doctorPage, 'doctor mobile review');
  await doctorPage.screenshot({ path: `${output}/doctor-summary-mobile.png`, fullPage: true });
  await doctorPage.getByRole('button', { name: '退出医生登录', exact: true }).click();
  await doctorPage.getByRole('heading', { name: '登录工作台', exact: true }).waitFor();
  assert.equal(await authStatus(patientPage, '/api/v1/patient/auth/session'), 200, 'Doctor logout must preserve patient login');
  assert.equal(await authStatus(doctorPage, '/api/v1/auth/session'), 401);
  await doctorPage.getByLabel('账号', { exact: true }).fill(doctorUsername);
  await doctorPage.getByLabel('密码', { exact: true }).fill(doctorPassword);
  await doctorPage.getByRole('button', { name: '登录工作台', exact: true }).click();
  await doctorPage.getByRole('button', { name: '退出医生登录', exact: true }).waitFor();
  await patientPage.getByRole('button', { name: '退出', exact: true }).click();
  await patientPage.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
  await noOverflow(patientPage, 'patient mobile login');
  assert.equal(await authStatus(patientPage, '/api/v1/patient/auth/session'), 401);
  assert.equal(await authStatus(doctorPage, '/api/v1/auth/session'), 200, 'Patient logout must preserve doctor login');
  assert.deepEqual(errors, [], 'Browser must not emit uncaught page errors');
  if(serverSpeech)assert.ok(ttsCalls>=2,'Opening and next prompts must play through the real WAV download/decode path');
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, browser: 'Chrome desktop engine', syntheticMicrophone: true, syntheticSpeechPlayback: true, syntheticAsrAndDialogue: true, speechMode:serverSpeech?'server':'browser',browserSpeechApiAbsent:serverSpeech,serverWavDecodeAndPlayback:serverSpeech,ttsCalls,asrCalls, uploadedWavBytes, sharedSummaryItems: patientItems.length, patientAndDoctorCookiesIndependent: true, mobileViewport: '390x844', actualMobileHardwareVerified: false }, null, 2));
  console.log('Browser acceptance passed: separate doctor/patient logins, first-password change, doctor provisioning/record/task, voice-only WAV call with automatic silence segmentation, identical saved summaries, task completion, published feedback, independent logout, 390px layouts. Microphone audio, speech playback, ASR and dialogue are synthetic; physical phones are not covered.');
} catch (error) {
  if (!sensitiveScreen) {
    await Promise.allSettled([
      doctorPage?.screenshot({ path: `${output}/doctor-error.png`, fullPage: true }),
      patientPage?.screenshot({ path: `${output}/patient-error.png`, fullPage: true }),
    ]);
  }
  console.error(`Browser acceptance failed at stage: ${stage}`);
  if (errors.length) console.error('Uncaught browser errors:', errors);
  throw error;
} finally {
  await Promise.allSettled([context?.close(), browser?.close()]);
  try { await app?.close(); }
  finally { await fixture.dispose(); }
}
