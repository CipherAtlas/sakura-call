import assert from "node:assert/strict";
import test from "node:test";
import { createEnhancedMicrophoneStream } from "./audioEnhancement";

class Parameter {
  value = 1;
  setTargetAtTime(value: number) { this.value = value; }
  cancelAndHoldAtTime() {}
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
}

class Node {
  gain = new Parameter();
  delayTime = new Parameter();
  threshold = new Parameter();
  knee = new Parameter();
  ratio = new Parameter();
  attack = new Parameter();
  release = new Parameter();
  connections: Node[] = [];
  sample = 128;
  connect(node: Node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
  getByteTimeDomainData(data: Uint8Array) { data.fill(this.sample); }
}

test("quiet and loud meter readings do not automatically boost or compress the voice path", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let tick: FrameRequestCallback = () => {};
  const gains: Node[] = [];
  const analysers: Node[] = [];
  const dynamics: Node[] = [];
  let closed = false;
  let rawStopped = false;
  let processedStopped = false;
  const processedTrack = { stop: () => { processedStopped = true; } };
  const processedStream = { getAudioTracks: () => [processedTrack], getTracks: () => [processedTrack] };
  class Context {
    currentTime = 0;
    sampleRate = 48000;
    constructor(options: AudioContextOptions) { assert.equal(options.sampleRate, 48000); }
    createMediaStreamSource() { return new Node(); }
    createChannelSplitter() { return new Node(); }
    createGain() { const node = new Node(); gains.push(node); return node; }
    createAnalyser() { const node = new Node(); analysers.push(node); return node; }
    createDelay() { return new Node(); }
    createDynamicsCompressor() { const node = new Node(); dynamics.push(node); return node; }
    createMediaStreamDestination() { return Object.assign(new Node(), { stream: processedStream }); }
    async resume() {}
    async close() { closed = true; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    AudioContext: Context,
    requestAnimationFrame: (callback: FrameRequestCallback) => { tick = callback; return 1; },
    cancelAnimationFrame: () => {},
  } });
  const rawTrack = { getSettings: () => ({ channelCount: 1 }), stop: () => { rawStopped = true; } };
  const rawStream = { getAudioTracks: () => [rawTrack], getTracks: () => [rawTrack] } as unknown as MediaStream;
  try {
    const controller = await createEnhancedMicrophoneStream(rawStream, 0.5, { microphoneChannelMode: "auto", noiseGate: 0, noiseReduction: 0 });
    assert.equal(controller.stream, processedStream);
    const baseline = gains.map(node => node.gain.value);
    for (const sample of [129, 135, 170, 128, 129]) {
      for (const analyser of analysers) analyser.sample = sample;
      for (let frame = 1; frame <= 60; frame++) tick(frame * 20);
      assert.deepEqual(gains.map(node => node.gain.value), baseline);
    }
    assert.equal(dynamics.length, 1, "only peak protection remains");
    assert.equal(dynamics[0].threshold.value, -1);
    controller.setGain(0.75);
    assert.equal(gains.filter((node, index) => node.gain.value !== baseline[index]).length, 1, "manual input gain remains available");
    controller.stop();
    assert.ok(rawStopped && processedStopped && closed);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
