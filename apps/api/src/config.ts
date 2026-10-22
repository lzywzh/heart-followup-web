import { config as dotenv } from 'dotenv';

export interface AppConfig {
  nodeEnv: string; authMode: 'development' | 'wechat' | 'web'; collectionMode: 'scripted' | 'ai';
  host: string; port: number; publicOrigin: string; sessionSecret: string;
  wxAppId: string; wxAppSecret: string; deepseekApiKey: string; deepseekModel: string;
  aliyunAsrAppKey: string; aliyunAccessKeyId: string; aliyunAccessKeySecret: string; aliyunAsrUrl: string;
  dashscopeApiKey: string; dashscopeUrl: string; ttsModel: string; ttsVoice: string; protocolApproved: boolean;
  localAsrUrl?: string; localTtsUrl?: string; voiceTtsMode?: 'browser' | 'cloud' | 'server' | 'auto';
}

export function validateConfig(c: AppConfig) {
  if (c.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  if (c.nodeEnv === 'production' && (c.authMode === 'development' || c.collectionMode === 'scripted')) throw new Error('Production rejects development authentication and scripted collection');
  return c;
}

export function readConfig(): AppConfig {
  dotenv({ quiet: true });
  const e = process.env;
  return validateConfig({
    nodeEnv: e.NODE_ENV || 'development', authMode: e.AUTH_MODE === 'development' ? 'development' : e.AUTH_MODE === 'wechat' ? 'wechat' : 'web', collectionMode: e.COLLECTION_MODE === 'scripted' ? 'scripted' : 'ai',
    host: e.HOST || '127.0.0.1', port: Number(e.PORT || 3200), publicOrigin: e.PUBLIC_ORIGIN || 'http://127.0.0.1:3200', sessionSecret: e.SESSION_SECRET || '',
    wxAppId: e.WX_APP_ID || '', wxAppSecret: e.WX_APP_SECRET || '', deepseekApiKey: e.DEEPSEEK_API_KEY || '', deepseekModel: e.DEEPSEEK_MODEL || 'deepseek-chat',
    aliyunAsrAppKey: e.ALIYUN_ASR_APP_KEY || '', aliyunAccessKeyId: e.ALIYUN_ACCESS_KEY_ID || '', aliyunAccessKeySecret: e.ALIYUN_ACCESS_KEY_SECRET || '',
    aliyunAsrUrl: e.ALIYUN_ASR_URL || 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1',
    dashscopeApiKey: e.DASHSCOPE_API_KEY || '', dashscopeUrl: e.DASHSCOPE_WS_URL || '', ttsModel: e.TTS_MODEL || 'cosyvoice-v3-flash', ttsVoice: e.TTS_VOICE || 'longanyang',
    protocolApproved: e.CLINICAL_PROTOCOL_APPROVED === 'true',
    localAsrUrl: e.LOCAL_ASR_URL || '', localTtsUrl: e.LOCAL_TTS_URL || '', voiceTtsMode: e.VOICE_TTS_MODE === 'server' ? 'server' : e.VOICE_TTS_MODE === 'cloud' ? 'cloud' : e.VOICE_TTS_MODE === 'auto' ? 'auto' : 'browser',
  });
}
