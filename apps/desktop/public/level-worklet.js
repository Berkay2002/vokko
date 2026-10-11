// AudioWorklet processor for the microphone level tap (see inputChain.ts). Served from public/ as a plain file
// so the app CSP needs neither blob: nor data: scripts. Posts one RMS value in dBFS per `frameMs` of audio.
class VokkoLevel extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameMs = (options && options.processorOptions && options.processorOptions.frameMs) || 10;
    this.sum = 0;
    this.n = 0;
    this.block = Math.round((sampleRate * frameMs) / 1000);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.sum += channel[i] * channel[i];
        if (++this.n >= this.block) {
          const rms = Math.sqrt(this.sum / this.n);
          this.port.postMessage(rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100);
          this.sum = 0;
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("vokko-level", VokkoLevel);
