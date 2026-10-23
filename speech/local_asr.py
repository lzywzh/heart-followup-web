"""Loopback SenseVoice ASR. Input audio and recognized text are never persisted or logged."""
import io
import json
import os
import re
import threading
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

MAX_BYTES=1_000_000
MAX_SAMPLES=30*16000


def build_transcriber(model_path,*,recognizer=None):
    import numpy as np
    if recognizer is None:
        import sherpa_onnx
        root=Path(model_path)
        recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(root/'model.int8.onnx'),tokens=str(root/'tokens.txt'),
            num_threads=2,language='zh',use_itn=True,debug=False,provider='cpu',
        )
    def transcribe(payload):
        if len(payload)>MAX_BYTES:raise ValueError('AUDIO_SIZE')
        try:
            with wave.open(io.BytesIO(payload),'rb') as audio:
                if audio.getnchannels()!=1 or audio.getsampwidth()!=2 or audio.getframerate()!=16000 or audio.getcomptype()!='NONE':raise ValueError('AUDIO_FORMAT')
                count=audio.getnframes()
                if not 1600<=count<=MAX_SAMPLES:raise ValueError('AUDIO_DURATION')
                pcm=audio.readframes(count)
                if len(pcm)!=count*2:raise ValueError('AUDIO_INCOMPLETE')
        except (wave.Error,EOFError) as error:raise ValueError('AUDIO_FORMAT') from error
        samples=np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768
        if float(np.sqrt(np.mean(samples*samples)))<.003:return ''
        stream=recognizer.create_stream();stream.accept_waveform(16000,samples)
        recognizer.decode_stream(stream)
        raw=stream.result.text
        if not isinstance(raw,str):raise RuntimeError('MODEL_RESULT_INVALID')
        if '<|nospeech|>' in raw.lower():return ''
        text=unicodedata.normalize('NFKC',re.sub(r'<\|[^|]*\|>','',raw)).strip()
        if len(text)>600:raise ValueError('TRANSCRIPT_TOO_LONG')
        return text
    return transcribe


class RecognitionServer(ThreadingHTTPServer):
    daemon_threads=True
    request_queue_size=8
    def __init__(self,transcribe,port):
        self.transcribe=transcribe;self.slot=threading.BoundedSemaphore(1)
        self.ready=True;self.timeout_seconds=30;self.exit_process=os._exit
        super().__init__(('127.0.0.1',port),Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def setup(self):
        super().setup();self.connection.settimeout(5)
    def reply(self,status,value):
        data=json.dumps(value,ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_GET(self):
        if self.path!='/health':return self.reply(404,{'error':'not_found'})
        self.reply(200 if self.server.ready else 503,{'ready':self.server.ready,'engine':'sensevoice-int8'})
    def do_POST(self):
        if self.path!='/transcribe':return self.reply(404,{'error':'not_found'})
        if self.headers.get('Content-Type','').split(';')[0].strip().lower() not in {'audio/wav','audio/x-wav'}:return self.reply(415,{'error':'wav_required'})
        try:size=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.reply(400,{'error':'invalid_length'})
        if not 0<size<=MAX_BYTES:return self.reply(413,{'error':'audio_size'})
        if not self.server.ready:return self.reply(503,{'error':'asr_unavailable'})
        if not self.server.slot.acquire(blocking=False):return self.reply(429,{'error':'busy'})
        completed=threading.Event();guard=threading.Lock();watchdog=None
        def expired():
            with guard:
                if completed.is_set():return
                self.server.ready=False
            self.server.exit_process(70)
        try:
            watchdog=threading.Timer(self.server.timeout_seconds,expired);watchdog.daemon=True;watchdog.start()
            payload=self.rfile.read(size)
            if not self.server.ready:raise RuntimeError('ASR_TIMEOUT')
            if len(payload)!=size:return self.reply(422,{'error':'incomplete_audio'})
            text=self.server.transcribe(payload)
            with guard:completed.set()
            if not self.server.ready:raise RuntimeError('ASR_TIMEOUT')
            if not isinstance(text,str):raise RuntimeError('INVALID_TRANSCRIPT')
            if not text.strip():return self.reply(422,{'error':'no_speech'})
            self.reply(200,{'text':text})
        except (ValueError,TimeoutError):self.reply(422,{'error':'cannot_transcribe'})
        except Exception:self.reply(503,{'error':'asr_unavailable'})
        finally:
            with guard:completed.set()
            if watchdog:watchdog.cancel()
            self.server.slot.release()


def make_server(transcribe,port=3010):return RecognitionServer(transcribe,port)


if __name__=='__main__':
    try:server=make_server(build_transcriber(os.environ['ASR_MODEL_PATH']),int(os.getenv('ASR_PORT','3010')))
    except Exception:raise SystemExit('ASR initialization failed; verify model files and dependencies.')
    server.serve_forever()
