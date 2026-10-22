import { AppError, unavailable } from '../errors.js';

const MAX_PCM_BYTES = 25 * 16000 * 2;

export function validateWav(bytes: Buffer) {
  if (bytes.length < 44 || bytes.length > MAX_PCM_BYTES + 4096 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AppError(400, 'INVALID_AUDIO', '录音格式不正确，请重新开始这一句');
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new AppError(400, 'INVALID_AUDIO', '录音没有完整上传，请重试');
  let format = false; let sampleBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + size > bytes.length) throw new AppError(400, 'INVALID_AUDIO', '录音没有完整上传，请重试');
    if (tag === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) {
        throw new AppError(400, 'INVALID_AUDIO', '请使用单声道16kHz语音录音');
      }
      format = true;
    }
    if (tag === 'data') sampleBytes += size;
    offset = start + size + (size % 2);
  }
  if (!format || sampleBytes < 3200 || sampleBytes > MAX_PCM_BYTES || sampleBytes % 2) throw new AppError(400, 'INVALID_AUDIO', '请说一句简短的话后再发送');
  return { durationMs: Math.round(sampleBytes / 32) };
}

export function createLocalAsr(baseUrl: string, fetchImpl = fetch) {
  let cached: { available: boolean } | undefined; let checkedAt = 0;
  const endpoint = baseUrl.replace(/\/$/, '');
  return {
    async status(): Promise<{available: boolean}> {
      if (!endpoint) return { available: false };
      if (cached && Date.now() - checkedAt < 3000) return cached;
      try {
        const response = await fetchImpl(endpoint + '/health', { signal: AbortSignal.timeout(2000) });
        cached = { available: response.ok && (await response.json() as any).ready === true };
      } catch { cached = { available: false }; }
      checkedAt = Date.now(); return cached;
    },
    async transcribe(bytes: Buffer): Promise<string> {
      if (!endpoint) throw unavailable('语音识别服务尚未连接，请联系管理员');
      let response: Response;
      try {
        response = await fetchImpl(endpoint + '/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(35000) });
      } catch { throw unavailable('语音识别暂未响应，请稍后重试这一句'); }
      if (response.status === 429) throw new AppError(429, 'ASR_BUSY', '语音识别正在处理其他请求，请稍后重试');
      if (response.status === 422) throw new AppError(422, 'NO_SPEECH', '没有听清这句话，请靠近麦克风重新说一次');
      if (!response.ok) throw unavailable('语音识别暂不可用，请稍后重试');
      let data: any;
      try { data = await response.json(); } catch { throw unavailable('语音识别没有完整返回，请重试'); }
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) throw new AppError(422, 'NO_SPEECH', '没有听清这句话，请重新说一次');
      if (text.length > 1000) throw new AppError(422, 'SPEECH_TOO_LONG', '这句话有些长，请分成短句回答');
      return text;
    },
  };
}
