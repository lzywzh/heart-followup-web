"""Loopback-only, single-inference Chinese TTS. Never persist or log input text."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import io
import json
import os
import threading
import time
import wave


class SpeechServer(ThreadingHTTPServer):
    daemon_threads=True
    request_queue_size=8
    def __init__(self,address,synthesize):
        self.synthesize=synthesize
        self.slot=threading.BoundedSemaphore(1)
        self.ready=True
        self.timeout_seconds=22
        self.exit_process=os._exit
        super().__init__(address,SpeechHandler)


class SpeechHandler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass
    def setup(self):
        super().setup()
        self.connection.settimeout(5)
    def send(self,status,data,content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass
    def error(self,status,code):
        self.send(status,json.dumps({'error':code}).encode())
    def do_GET(self):
        if self.path!='/health':return self.error(404,'NOT_FOUND')
        if not self.server.ready:return self.send(503,b'{"ready":false}')
        self.send(200,b'{"ready":true,"engine":"sherpa-onnx-matcha","voice":"zh-baker"}')
    def do_POST(self):
        if self.path!='/synthesize':return self.error(404,'NOT_FOUND')
        if self.headers.get('Content-Type','').split(';')[0].strip().lower()!='application/json':return self.error(415,'JSON_REQUIRED')
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.error(400,'INVALID_LENGTH')
        if length<1:return self.error(400,'EMPTY_REQUEST')
        if length>4096:return self.error(413,'REQUEST_TOO_LARGE')
        try:
            data=json.loads(self.rfile.read(length))
            if not isinstance(data,dict) or set(data)!={'text'}:raise ValueError()
            text=data['text']
            if not isinstance(text,str) or not text.strip() or len(text)>500:raise ValueError()
        except (ValueError,UnicodeError,TimeoutError):return self.error(400,'INVALID_REQUEST')
        if not self.server.ready:return self.error(503,'SYNTHESIS_UNAVAILABLE')
        if not self.server.slot.acquire(blocking=False):return self.error(429,'TTS_BUSY')
        completed=threading.Event()
        guard=threading.Lock()
        def expired():
            with guard:
                if completed.is_set():return
                self.server.ready=False
            self.server.exit_process(70)
        watchdog=threading.Timer(self.server.timeout_seconds,expired)
        watchdog.daemon=True
        watchdog.start()
        try:
            audio=self.server.synthesize(text)
            with guard:completed.set()
            if not self.server.ready:raise RuntimeError('TTS_TIMEOUT')
            if not isinstance(audio,bytes) or len(audio)<44 or len(audio)>4_000_000 or audio[:4]!=b'RIFF' or audio[8:12]!=b'WAVE':raise ValueError()
            self.send(200,audio,'audio/wav')
        except Exception:
            self.error(503,'SYNTHESIS_UNAVAILABLE')
        finally:
            with guard:completed.set()
            watchdog.cancel()
            self.server.slot.release()


def create_synthesizer(root):
    import numpy as np
    import sherpa_onnx
    model=Path(root)/'matcha-icefall-zh-baker'
    config=sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                acoustic_model=str(model/'model-steps-3.onnx'),
                vocoder=str(Path(root)/'vocos-22khz-univ.onnx'),
                lexicon=str(model/'lexicon.txt'),tokens=str(model/'tokens.txt'),
            ),num_threads=2,debug=False,provider='cpu',
        ),rule_fsts=','.join(str(model/name) for name in ['date.fst','number.fst','phone.fst']),max_num_sentences=1,
    )
    if not config.validate():raise RuntimeError('TTS_CONFIG_INVALID')
    engine=sherpa_onnx.OfflineTts(config)
    def synthesize(text):
        audio=engine.generate(text,sid=0,speed=1.03)
        samples=np.asarray(audio.samples)
        if not samples.size or not np.isfinite(samples).all():raise ValueError('TTS_AUDIO_INVALID')
        pcm=(np.clip(samples,-1,1)*32767).astype('<i2').tobytes()
        output=io.BytesIO()
        with wave.open(output,'wb') as stream:
            stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(audio.sample_rate);stream.writeframes(pcm)
        return output.getvalue()
    synthesize('您好。')
    return synthesize


if __name__=='__main__':
    try:
        synthesizer=create_synthesizer(os.environ.get('TTS_MODEL_ROOT','/opt/heart-followup-tts'))
        server=SpeechServer(('127.0.0.1',int(os.environ.get('TTS_PORT','3020'))),synthesizer)
    except Exception:
        raise SystemExit('Local TTS failed to initialize; check model files and runtime dependencies.')
    print('Local Chinese TTS ready on loopback.',flush=True)
    server.serve_forever()
