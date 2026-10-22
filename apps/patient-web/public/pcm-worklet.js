class PatientPcm extends AudioWorkletProcessor {
  process(inputs) {
    const channels=inputs[0];
    if(channels?.length&&channels[0]?.length){
      const mono=new Float32Array(channels[0].length);
      for(const channel of channels)for(let n=0;n<mono.length;n++)mono[n]+=channel[n]/channels.length;
      this.port.postMessage(mono,[mono.buffer]);
    }
    return true;
  }
}
registerProcessor('patient-pcm',PatientPcm);
