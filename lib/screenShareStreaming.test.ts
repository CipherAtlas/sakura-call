import assert from "node:assert/strict";
import test from "node:test";
import { adaptScreenStream, initialScreenAdaptation, preferScreenH264, screenAdaptationParameters, screenEncodingRates } from "./screenShareStreaming";
import { screenSharePresetDefaults } from "./screenShareQuality";

test("H264 preference affects only the screen transceiver and preserves every fallback and repair codec", () => {
  const codecs = ["VP8", "rtx", "H264", "H264", "VP9", "red", "ulpfec"].map((name, i) => ({ mimeType: `video/${name}`, clockRate: 90000, sdpFmtpLine: `profile=${i}` }));
  const original = Object.getOwnPropertyDescriptor(globalThis, "RTCRtpReceiver");
  Object.defineProperty(globalThis, "RTCRtpReceiver", { configurable: true, value: { getCapabilities: () => ({ codecs }) } });
  try {
    const screen = {} as MediaStreamTrack;
    let applied: RTCRtpCodec[] = [];
    const peer = { getTransceivers: () => [
      { sender: { track: {} }, setCodecPreferences: () => assert.fail("camera must not be changed") },
      { sender: { track: screen }, setCodecPreferences: (list: RTCRtpCodec[]) => { applied = list; } },
    ] } as unknown as RTCPeerConnection;
    assert.equal(preferScreenH264(peer, screen), true);
    assert.deepEqual(applied, [codecs[2], codecs[3], codecs[0], codecs[1], codecs[4], codecs[5], codecs[6]]);
    assert.equal(codecs[0].mimeType, "video/VP8");
    assert.equal(preferScreenH264(peer), true);
  } finally {
    if (original) Object.defineProperty(globalThis, "RTCRtpReceiver", original);
    else Reflect.deleteProperty(globalThis, "RTCRtpReceiver");
  }
});

test("unsupported codec preferences preserve browser defaults", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "RTCRtpReceiver");
  Object.defineProperty(globalThis, "RTCRtpReceiver", { configurable: true, value: { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }] }) } });
  try {
    const screen = {} as MediaStreamTrack;
    const peer = { getTransceivers: () => [{ sender: { track: screen }, setCodecPreferences: () => assert.fail("no H264 available") }] } as unknown as RTCPeerConnection;
    assert.equal(preferScreenH264(peer, screen), true);
  } finally {
    if (original) Object.defineProperty(globalThis, "RTCRtpReceiver", original);
    else Reflect.deleteProperty(globalThis, "RTCRtpReceiver");
  }
});

test("rates use recent deltas and exclude stale or replaced encoders", () => {
  const previous = { id: "one", timestamp: 1000, bytesSent: 1000, framesEncoded: 60, totalEncodeTime: 0.6 };
  const current = { id: "one", timestamp: 3000, bytesSent: 2001000, framesEncoded: 180, totalEncodeTime: 1.2 };
  assert.deepEqual(screenEncodingRates(current, previous), { bitrateKbps: 8000, fps: 60, encodeMs: 5 });
  assert.deepEqual(screenEncodingRates(current), {});
  assert.deepEqual(screenEncodingRates({ ...current, id: "new" }, previous), {});
  assert.deepEqual(screenEncodingRates(previous, previous), {});
  assert.equal(screenEncodingRates({ ...current, totalEncodeTime: undefined }, previous).encodeMs, undefined);
  assert.equal(screenEncodingRates({ ...previous, timestamp: 3000 }, previous).encodeMs, undefined);
});

test("one RTT spike does not degrade; sustained fresh spikes do", () => {
  let state = initialScreenAdaptation();
  state = adaptScreenStream(state, { now: 10000, active: true, freshRttMs: 8581 });
  assert.equal(state.level, 0);
  state = adaptScreenStream(state, { now: 12000, active: true, freshRttMs: 900 });
  assert.equal(state.level, 1);
  state = adaptScreenStream(state, { now: 14000, active: true, freshRttMs: 900 });
  state = adaptScreenStream(state, { now: 16000, active: true, freshRttMs: 900 });
  assert.equal(state.level, 1);
  assert.equal(adaptScreenStream(state, { now: 18000, active: true, freshRttMs: 900 }).level, 2);
});

test("CPU or bandwidth limitations trigger adaptation without RTT support", () => {
  for (const limitation of ["cpu", "bandwidth"]) {
    let state = adaptScreenStream(initialScreenAdaptation(), { now: 10000, active: true, limitation });
    state = adaptScreenStream(state, { now: 12000, active: true, limitation });
    assert.equal(state.level, 1);
  }
});

test("fresh RTT observations survive intervening polls without counting the old RTT again", () => {
  let state = adaptScreenStream(initialScreenAdaptation(), { now: 10000, active: true, limitation: "none", freshRttMs: 900 });
  for (const now of [12000, 14000]) state = adaptScreenStream(state, { now, active: true, limitation: "none" });
  assert.equal(state.level, 0);
  assert.equal(state.badSamples, 1);
  state = adaptScreenStream(state, { now: 16000, active: true, limitation: "none", freshRttMs: 900 });
  assert.equal(state.level, 1);
});

test("idle frames and absent RTT cannot trigger degradation or premature recovery", () => {
  let state = { ...initialScreenAdaptation(), level: 2 };
  for (let now = 10000; now < 100000; now += 2000) {
    state = adaptScreenStream(state, { now, active: false, freshRttMs: 900, limitation: "bandwidth" });
    state = adaptScreenStream(state, { now, active: true, limitation: "none" });
  }
  assert.equal(state.level, 2);
});

test("recovery requires five fresh healthy observations and restores one step at a time", () => {
  let state = { ...initialScreenAdaptation(), level: 2, lastChange: 10000 };
  for (let i = 0; i < 4; i++) state = adaptScreenStream(state, { now: 30000 + i * 2000, active: true, limitation: "none", freshRttMs: 60 });
  assert.equal(state.level, 2);
  state = adaptScreenStream(state, { now: 40000, active: true, limitation: "none", freshRttMs: 60 });
  assert.equal(state.level, 1);
});

test("quality steps stay inside the selected target and prioritize bitrate before frame rate and resolution", () => {
  const settings = screenSharePresetDefaults.motion;
  assert.deepEqual(screenAdaptationParameters(settings, 0), { maxBitrateKbps: 8500, maxFramerate: 60, scaleResolutionDownBy: 1 });
  assert.deepEqual(screenAdaptationParameters(settings, 1), { maxBitrateKbps: 6375, maxFramerate: 60, scaleResolutionDownBy: 1 });
  assert.equal(screenAdaptationParameters(settings, 3).maxFramerate, 30);
  assert.equal(screenAdaptationParameters(settings, 4).scaleResolutionDownBy, 1.5);
  assert.equal(screenAdaptationParameters(screenSharePresetDefaults.detail, 4).maxFramerate, 15);
  assert.equal(screenAdaptationParameters({ ...settings, bitrateKbps: 500 }, 4).maxBitrateKbps, 500);
  let state = initialScreenAdaptation();
  for (let now = 10000; now < 200000; now += 6000) state = adaptScreenStream(state, { now, active: true, limitation: "bandwidth" });
  assert.equal(state.level, 4);
});
