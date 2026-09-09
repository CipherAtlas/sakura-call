import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parseAudioSegment } from "../server/captions";

function capture(inputRate: number) {
  const messages: { audio: ArrayBuffer; durationMs: number }[] = [];
  let processor: { process(inputs: Float32Array[][]): boolean };
  runInNewContext(readFileSync(new URL("../public/worklets/caption-capture.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { postMessage: (message: typeof messages[number]) => messages.push(message) }; },
    sampleRate: inputRate,
    registerProcessor: (_name: string, Constructor: new () => typeof processor) => { processor = new Constructor(); }
  });
  return {
    messages,
    feed(seconds: number, amplitude: number) {
      let remaining = Math.round(seconds * inputRate);
      while (remaining) {
        const length = Math.min(128, remaining);
        assert.equal(processor.process([[new Float32Array(length).fill(amplitude)]]), true);
        remaining -= length;
      }
    }
  };
}

for (const rate of [16000, 44100, 48000]) {
  test(`caption worklet produces mono 16 kHz WAV with correct duration from ${rate} Hz`, () => {
    const c = capture(rate);
    c.feed(0.5, 0.1);
    c.feed(1.6, 0);
    assert.equal(c.messages.length, 1);
    const message = c.messages[0];
    const wav = new DataView(message.audio);
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint16(22, true), 1);
    assert.equal(wav.getUint16(34, true), 16);
    assert.equal(message.durationMs, 2000);
    assert.equal(wav.getUint32(40, true), 64000);
    assert.ok(wav.getInt16(44, true) > 0);
    assert.ok(parseAudioSegment({ audio: Buffer.from(message.audio), isFinal: true, clientSegmentId: "worklet" }));
  });
}

test("silence and brief clicks do not submit captions; subsequent speech still works", () => {
  const c = capture(48000);
  c.feed(2, 0);
  c.feed(0.05, 0.1);
  c.feed(2, 0);
  assert.equal(c.messages.length, 0);
  c.feed(0.5, 0.1);
  c.feed(2, 0);
  assert.equal(c.messages.length, 1);
});

test("caption ingress rejects arbitrary binary, malformed metadata and corrupt WAV lengths", () => {
  const c = capture(48000);
  c.feed(0.5, 0.1); c.feed(1.6, 0);
  const valid = { audio: Buffer.from(c.messages[0].audio), isFinal: true, clientSegmentId: "valid" };
  assert.equal(parseAudioSegment(null), null);
  assert.equal(parseAudioSegment({ ...valid, audio: Buffer.alloc(1644) }), null);
  assert.equal(parseAudioSegment({ ...valid, isFinal: "true" }), null);
  assert.equal(parseAudioSegment({ ...valid, clientSegmentId: "x".repeat(129) }), null);
  const corrupt = Buffer.from(valid.audio);
  corrupt.writeUInt32LE(42, 40);
  assert.equal(parseAudioSegment({ ...valid, audio: corrupt }), null);
});

test("continuous speech is bounded to twelve-second segments", () => {
  const c = capture(44100);
  c.feed(25, 0.1);
  assert.deepEqual(c.messages.map(m => m.durationMs), [12000, 12000]);
});
