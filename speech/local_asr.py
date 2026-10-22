"""Loopback-only CPU speech recognition. Audio stays in memory and is never logged."""
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 1_500_000
ALLOWED_TYPES = {'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav'}


def make_server(transcribe, port=3010):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'ready': self.path == '/health'})

        def do_POST(self):
            if self.path != '/transcribe':
                return self.reply(404, {'error': 'not_found'})
            mime = self.headers.get('Content-Type', '').split(';')[0].lower()
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self.reply(400, {'error': 'invalid_length'})
            if mime not in ALLOWED_TYPES:
                return self.reply(415, {'error': 'unsupported_format'})
            if not 0 < size <= MAX_BYTES:
                return self.reply(413, {'error': 'audio_size'})
            if not lock.acquire(blocking=False):
                return self.reply(429, {'error': 'busy'})
            try:
                self.connection.settimeout(20)
                payload = self.rfile.read(size)
                if len(payload) != size:
                    return self.reply(400, {'error': 'incomplete_audio'})
                text = transcribe(payload)
                return self.reply(200, {'text': str(text).strip()[:600]})
            except Exception:
                return self.reply(422, {'error': 'cannot_transcribe'})
            finally:
                lock.release()

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def build_transcriber(model_path):
    import av
    import numpy as np
    from faster_whisper import WhisperModel
    model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)

    def transcribe(payload):
        frames = []
        samples = 0
        with av.open(io.BytesIO(payload)) as container:
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    values = converted.to_ndarray().reshape(-1)
                    samples += values.size
                    if samples > 30 * 16000:
                        raise ValueError('audio_too_long')
                    frames.append(values)
            for converted in resampler.resample(None):
                frames.append(converted.to_ndarray().reshape(-1))
        if not frames:
            return ''
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        if len(audio) > 30 * 16000 or np.sqrt(np.mean(audio ** 2)) < 0.003:
            return ''
        segments, _ = model.transcribe(audio, language='zh', beam_size=1, temperature=0, condition_on_previous_text=False, vad_filter=False, initial_prompt='以下是普通话随访对话，使用简体中文。气喘，气短，呼吸，脚踝水肿，体重，遵医嘱用药。')
        return ''.join(segment.text for segment in segments if segment.no_speech_prob < .7 and segment.avg_logprob > -1.3)

    return transcribe


if __name__ == '__main__':
    server = make_server(build_transcriber(os.environ['ASR_MODEL_PATH']), int(os.getenv('ASR_PORT', '3010')))
    print('Local speech recognition ready on loopback', flush=True)
    server.serve_forever()
