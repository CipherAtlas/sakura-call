/* global AudioWorkletProcessor, registerProcessor, sampleRate */
const outputSampleRate = 16000;
const frameSamples = 160;

function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]]) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, buffer.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return buffer;
}

class CaptionCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / outputSampleRate;
    this.remaining = this.ratio;
    this.sum = 0;
    this.frame = new Float32Array(frameSamples);
    this.frameOffset = 0;
    this.preRoll = [];
    this.resetSegment();
  }

  resetSegment() {
    this.chunks = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalMs = 0;
  }

  handleFrame() {
    let energy = 0;
    const pcm = new Int16Array(frameSamples);
    for (let i = 0; i < frameSamples; i++) {
      const value = Math.max(-1, Math.min(1, this.frame[i]));
      energy += value * value;
      pcm[i] = value * (value < 0 ? 32768 : 32767);
    }
    const hasSpeech = Math.sqrt(energy / frameSamples) >= 0.004;
    this.preRoll.push(pcm);
    if (this.preRoll.length > 90) this.preRoll.shift();

    if (!this.chunks.length) {
      if (!hasSpeech) return;
      this.chunks = [...this.preRoll];
      this.totalMs = this.chunks.length * 10;
    } else {
      this.chunks.push(pcm);
      this.totalMs += 10;
    }
    if (hasSpeech) {
      this.speechMs += 10;
      this.silenceMs = 0;
    } else {
      this.silenceMs += 10;
    }

    if (this.silenceMs >= 1500 || this.totalMs >= 12000) {
      if (this.speechMs >= 180) {
        const samples = new Int16Array(this.chunks.length * frameSamples);
        this.chunks.forEach((chunk, i) => samples.set(chunk, i * frameSamples));
        const audio = encodeWav(samples);
        this.port.postMessage({ audio, durationMs: this.totalMs }, [audio]);
      }
      this.resetSegment();
      this.preRoll = [];
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Carry fractional sample weights across render quanta, including 44.1 kHz input.
    for (const sample of input) {
      let available = 1;
      while (available > 1e-8) {
        const weight = Math.min(available, this.remaining);
        this.sum += sample * weight;
        this.remaining -= weight;
        available -= weight;
        if (this.remaining < 1e-8) {
          this.frame[this.frameOffset++] = this.sum / this.ratio;
          this.remaining = this.ratio;
          this.sum = 0;
          if (this.frameOffset === frameSamples) {
            this.handleFrame();
            this.frameOffset = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("sakura-caption-capture", CaptionCaptureProcessor);
