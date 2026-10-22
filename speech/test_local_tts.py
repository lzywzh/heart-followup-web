import http.client
import io
import json
import threading
import unittest
import wave
from local_tts import SpeechServer

def silence():
    output=io.BytesIO()
    with wave.open(output,'wb') as stream:
        stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(22050);stream.writeframes(b'\x00\x00'*2205)
    return output.getvalue()

class SpeechHttpTest(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        def synthesize(text):
            self.calls.append(text)
            return silence()
        self.server=SpeechServer(('127.0.0.1',0),synthesize)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
    def request(self,path,body=None,method='POST',content_type='application/json'):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        connection.request(method,path,body.encode('utf-8') if isinstance(body,str) else body,{'Content-Type':content_type})
        response=connection.getresponse();result=(response.status,dict(response.getheaders()),response.read());connection.close();return result
    def test_health_and_standard_wav(self):
        status,_,data=self.request('/health',method='GET')
        self.assertEqual(status,200);self.assertTrue(json.loads(data)['ready'])
        status,headers,data=self.request('/synthesize',json.dumps({'text':'您好，请说说最近的身体情况。'}))
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'audio/wav');self.assertEqual(data[:4],b'RIFF')
        self.assertEqual(len(self.calls),1);self.assertEqual(headers['Cache-Control'],'no-store')
    def test_invalid_and_oversized_inputs_never_reach_model(self):
        for body in [json.dumps({'text':''}),json.dumps({'text':'字'*501}),json.dumps({'text':'您好','other':1}),'invalid']:
            self.assertEqual(self.request('/synthesize',body)[0],400)
        self.assertEqual(self.request('/synthesize','x'*5000)[0],413)
        self.assertEqual(self.request('/synthesize','hello',content_type='text/plain')[0],415)
        self.assertEqual(self.calls,[])
    def test_busy_and_engine_errors_return_no_patient_text(self):
        self.server.slot.acquire()
        try:self.assertEqual(self.request('/synthesize','{"text":"您好"}')[0],429)
        finally:self.server.slot.release()
        def failing(text):raise RuntimeError('private patient contents')
        self.server.synthesize=failing
        status,_,data=self.request('/synthesize','{"text":"您好"}')
        self.assertEqual(status,503);self.assertNotIn(b'private',data)
    def test_stalled_inference_marks_unhealthy_and_requests_a_process_restart(self):
        stopped=threading.Event();released=threading.Event()
        self.server.timeout_seconds=.04
        self.server.exit_process=lambda code:stopped.set()
        self.server.synthesize=lambda text:(released.wait(.5),silence())[1]
        responses=[]
        caller=threading.Thread(target=lambda:responses.append(self.request('/synthesize','{"text":"hello"}')),daemon=True)
        caller.start()
        try:
            self.assertTrue(stopped.wait(.25),'A stalled model must request process recovery')
            self.assertEqual(self.request('/health',method='GET')[0],503)
        finally:released.set();caller.join()
        self.assertEqual(responses[0][0],503)

if __name__=='__main__':unittest.main()
