export function encodeWav(samples:Float32Array,rate:number):ArrayBuffer {
  if(!Number.isFinite(rate)||rate<8000)throw new Error('录音采样率不可用');
  const size=Math.min(16000*24,Math.floor(samples.length*16000/rate));
  const bytes=new ArrayBuffer(44+size*2);const view=new DataView(bytes);
  const label=(offset:number,text:string)=>{for(let n=0;n<text.length;n++)view.setUint8(offset+n,text.charCodeAt(n));};
  label(0,'RIFF');view.setUint32(4,36+size*2,true);label(8,'WAVE');label(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,size*2,true);
  // Area averaging attenuates high frequency content when downsampling device PCM.
  for(let n=0;n<size;n++){
    const from=n*rate/16000,to=(n+1)*rate/16000;let sum=0;
    for(let k=Math.floor(from);k<Math.ceil(to);k++)sum+=(samples[Math.min(k,samples.length-1)]||0)*Math.max(0,Math.min(k+1,to)-Math.max(k,from));
    const value=Math.max(-1,Math.min(1,sum/(to-from)));view.setInt16(44+n*2,Math.round(value*(value<0?32768:32767)),true);
  }
  return bytes;
}
export class SilenceSegmenter {
  private total=0;private speech=0;private quiet=0;private noise=.003;
  constructor(private rate:number) {}
  push(samples:Float32Array) {
    let power=0;for(const value of samples)power+=value*value;
    const rms=Math.sqrt(power/Math.max(1,samples.length));const seconds=samples.length/this.rate;this.total+=seconds;
    const voiced=rms>Math.max(.012,this.noise*3);
    if(voiced){this.speech+=seconds;this.quiet=0;}else{this.quiet+=seconds;if(!this.speech)this.noise=.95*this.noise+.05*Math.min(rms,.015);}
    return { voiced:this.speech>=.12, level:Math.min(1,rms*8), finish:this.total>=24 || (this.speech>=.12&&this.quiet>=.85) };
  }
}
