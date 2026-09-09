import assert from "node:assert/strict";
import test from "node:test";
import { configureCallAudioDescription } from "./webrtcAudio";

function audio(mid: string, stream: string, payload = "111", fmtp = "minptime=10;useinbandfec=1") {
  return [
    `m=audio 9 UDP/TLS/RTP/SAVPF ${payload}`,
    `a=mid:${mid}`,
    ...(stream ? [`a=msid:${stream} track-${mid}`] : []),
    `a=rtpmap:${payload} opus/48000/2`,
    ...(fmtp ? [`a=fmtp:${payload} ${fmtp}`] : []),
    "a=sendrecv",
    "",
  ].join("\r\n");
}

test("screen offer uses separate mono voice and stereo music profiles while preserving video and FEC", () => {
  const microphone = audio("0", "mic");
  const video = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=msid:screen video\r\n";
  const offer = { type: "offer" as const, sdp: "v=0\r\n" + microphone + video + audio("2", "screen") };
  const tuned = configureCallAudioDescription(offer, "screen");
  assert.ok(tuned.sdp?.includes(video));
  assert.match(tuned.sdp!, /a=mid:0[\s\S]*?stereo=0;maxaveragebitrate=96000;maxplaybackrate=48000;usedtx=0/);
  assert.match(tuned.sdp!, /minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=192000;maxplaybackrate=48000;usedtx=0;sprop-stereo=1/);
  assert.deepEqual(configureCallAudioDescription(tuned, "screen"), tuned);
  assert.equal(offer.sdp.includes("stereo=1"), false);
});

test("receive-only answer advertises stereo for the offered screen MID, not the microphone", () => {
  const offer = configureCallAudioDescription({ type: "offer", sdp: audio("0", "mic") + audio("2", "screen") }, "screen");
  const microphone = audio("0", "other-mic");
  const answer = configureCallAudioDescription({
    type: "answer",
    sdp: microphone + audio("2", "", "109", "").replace("a=sendrecv", "a=recvonly"),
  }, undefined, offer);
  assert.match(answer.sdp!, /a=mid:0[\s\S]*?stereo=0;maxaveragebitrate=96000/);
  assert.match(answer.sdp!, /a=fmtp:109 stereo=1;maxaveragebitrate=192000/);
  assert.ok(!answer.sdp?.includes("sprop-stereo=1"));
  assert.match(answer.sdp!, /a=recvonly/);
});

test("receiver-initiated renegotiation retains screen quality from the sharer's previous answer", () => {
  const remoteAnswer = configureCallAudioDescription({ type: "answer", sdp: audio("3", "screen") }, "screen");
  const nextOffer = configureCallAudioDescription({ type: "offer", sdp: audio("3", "") }, undefined, remoteAnswer);
  assert.match(nextOffer.sdp!, /stereo=1;maxaveragebitrate=192000/);
});

test("existing Opus values are replaced without duplicates and other codec parameters survive", () => {
  const result = configureCallAudioDescription({ type: "offer", sdp: audio("2", "screen", "109", "stereo=0;maxaveragebitrate=32000;usedtx=1;useinbandfec=1") }, "screen");
  assert.match(result.sdp!, /stereo=1;maxaveragebitrate=192000;usedtx=0;useinbandfec=1/);
  assert.equal(result.sdp?.match(/(?:;| )stereo=/g)?.length, 1);
});

test("missing SDP, unsupported codecs and stopped sections remain unchanged", () => {
  for (const sdp of [undefined, audio("2", "screen").replace("opus/48000/2", "PCMU/8000"), audio("2", "screen").replace("m=audio 9", "m=audio 0"), audio("2", "screen").replace("a=sendrecv", "a=inactive")]) {
    const description = { type: "offer" as const, sdp };
    assert.deepEqual(configureCallAudioDescription(description, "screen"), description);
  }
});

test("voice-only calls advertise full-band mono Opus in both offer and answer", () => {
  for (const type of ["offer", "answer"] as const) {
    const result = configureCallAudioDescription({ type, sdp: audio("0", "mic", "109", "maxplaybackrate=8000;stereo=1;usedtx=1;useinbandfec=1") });
    assert.match(result.sdp!, /maxplaybackrate=48000;stereo=0;usedtx=0;useinbandfec=1;maxaveragebitrate=96000/);
    assert.ok(!result.sdp?.includes("sprop-stereo=1"));
    assert.deepEqual(configureCallAudioDescription(result), result);
  }
});
