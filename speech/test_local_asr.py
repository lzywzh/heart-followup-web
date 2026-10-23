import io
import json
import threading
import unittest
import wave
import socket
from types import SimpleNamespace
from http.client import HTTPConnection
from local_asr import build_transcriber,make_server

def wav(amplitude=1200,frames=8000,rate=16000,channels=1):
    result=io.BytesIO()
    with wave.open(result,'wb') as audio:
        audio.setnchannels(channels);audio.setsampwidth(2);audio.setframerate(rate)
        audio.writeframes(int(amplitude).to_bytes(2,'little',signed=True)*frames*channels)
    return result.getvalue()

class Engine:
    def __init__(self,text='小腿没有肿。'):
        self.text=text;self.calls=[]
    def create_stream(self):
        engine=self
        class Stream:
            result=SimpleNamespace(text=engine.text)
            def accept_waveform(self,rate,samples):engine.calls.append((rate,len(samples)))
        return Stream()
    def decode_stream(self,stream):pass

class RecognitionTest(unittest.TestCase):
    def test_real_pcm_reaches_decoder_without_a_medical_word_prompt(self):
        engine=Engine('不是６５公斤，是５６公斤。')
        transcribe=build_transcriber('unused',recognizer=engine)
        self.assertEqual(transcribe(wav()),'不是65公斤,是56公斤。')
        self.assertEqual(engine.calls,[(16000,8000)])
    def test_silence_malformed_wrong_rate_and_long_audio_never_reach_decoder(self):
        engine=Engine();transcribe=build_transcriber('unused',recognizer=engine)
        self.assertEqual(transcribe(wav(amplitude=0)),'')
        for audio in [b'not audio',wav(rate=8000),wav(channels=2),wav(frames=16000*31),wav()[:-10]]:
            with self.assertRaises(ValueError):transcribe(audio)
        self.assertEqual(engine.calls,[])
    def test_voice_tags_and_no_speech_are_not_patient_text(self):
        for text,expected in [('<|zh|><|NEUTRAL|><|Speech|>体重没有明显变化。','体重没有明显变化。'),('<|zh|><|nospeech|>','')]:
            self.assertEqual(build_transcriber('unused',recognizer=Engine(text))(wav()),expected)

class HttpTest(unittest.TestCase):
    def setUp(self):
        self.server=make_server(lambda audio:'没有气短。',port=0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
    def request(self,path='/transcribe',body=None,method='POST'):
        connection=HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        connection.request(method,path,body or wav(),{'Content-Type':'audio/wav'})
        response=connection.getresponse();result=(response.status,dict(response.getheaders()),json.loads(response.read()));connection.close();return result
    def test_compatible_text_response_and_no_persistent_cache(self):
        status,headers,data=self.request()
        self.assertEqual(status,200);self.assertEqual(data,{'text':'没有气短。'})
        self.assertEqual(headers.get('Cache-Control'),'no-store')
        self.assertEqual(self.request('/health',method='GET')[2]['engine'],'sensevoice-int8')
    def test_busy_empty_and_engine_failure_are_not_fabricated_transcripts(self):
        self.server.slot.acquire()
        try:self.assertEqual(self.request()[0],429)
        finally:self.server.slot.release()
        self.server.transcribe=lambda audio:''
        self.assertEqual(self.request()[0],422)
        def broken(audio):raise RuntimeError('private contents')
        self.server.transcribe=broken
        status,_,data=self.request();self.assertEqual(status,503);self.assertNotIn('private',json.dumps(data))
    def test_hung_decoder_becomes_unhealthy_and_requests_restart(self):
        stopped=threading.Event();released=threading.Event();responses=[]
        self.server.timeout_seconds=.04;self.server.exit_process=lambda code:stopped.set()
        self.server.transcribe=lambda audio:(released.wait(.5),'late patient text')[1]
        caller=threading.Thread(target=lambda:responses.append(self.request()),daemon=True);caller.start()
        try:
            self.assertTrue(stopped.wait(.25))
            self.assertEqual(self.request('/health',method='GET')[0],503)
        finally:released.set();caller.join()
        self.assertEqual(responses[0][0],503)
    def test_slow_body_cannot_hold_the_only_slot_without_a_deadline(self):
        stopped=threading.Event();decoded=[]
        self.server.timeout_seconds=.05;self.server.exit_process=lambda code:stopped.set()
        self.server.transcribe=lambda audio:(decoded.append(audio),'late text')[1]
        body=wav();client=socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2)
        try:
            client.sendall(f'POST /transcribe HTTP/1.0\r\nContent-Type: audio/wav\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body[:1])
            self.assertTrue(stopped.wait(.5))
            self.assertEqual(self.request('/health',method='GET')[0],503)
            client.sendall(body[1:]);client.recv(4096)
            self.assertEqual(decoded,[])
        finally:client.close()

if __name__=='__main__':unittest.main()
