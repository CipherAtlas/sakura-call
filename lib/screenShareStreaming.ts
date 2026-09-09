import type { ScreenShareQualitySettings } from "./screenShareQuality";

export type ScreenShareStatsSnapshot = {
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  path: "direct" | "relay" | "unknown";
  roundTripMs?: number;
  limitation?: string;
  recipient?: string;
  codec?: string;
  encoder?: string;
  powerEfficient?: boolean;
  encodeMs?: number;
  bitrateLimitKbps?: number;
};

export function preferScreenH264(peer: RTCPeerConnection, track?: MediaStreamTrack) {
  if (!track || typeof RTCRtpReceiver === "undefined" || !RTCRtpReceiver.getCapabilities) return true;
  const transceiver = peer.getTransceivers().find(item => item.sender.track === track);
  if (!transceiver?.setCodecPreferences) return true;
  try {
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    if (!codecs.some(codec => codec.mimeType.toLowerCase() === "video/h264")) return true;
    // Preserve all browser-provided profiles, fallback codecs and repair codecs.
    transceiver.setCodecPreferences([
      ...codecs.filter(codec => codec.mimeType.toLowerCase() === "video/h264"),
      ...codecs.filter(codec => codec.mimeType.toLowerCase() !== "video/h264"),
    ]);
    return true;
  } catch (error) {
    console.warn("Screen-share codec preference could not be applied", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

export type ScreenEncodingSample = {
  id: string;
  timestamp: number;
  bytesSent?: number;
  framesEncoded?: number;
  totalEncodeTime?: number;
  rttMeasurements?: number;
};

export function screenEncodingRates(current: ScreenEncodingSample, previous?: ScreenEncodingSample) {
  if (!previous || previous.id !== current.id || current.timestamp <= previous.timestamp) return {};
  const elapsed = current.timestamp - previous.timestamp;
  const bytes = current.bytesSent !== undefined && previous.bytesSent !== undefined
    ? current.bytesSent - previous.bytesSent : undefined;
  const frames = current.framesEncoded !== undefined && previous.framesEncoded !== undefined
    ? current.framesEncoded - previous.framesEncoded : undefined;
  const encodeTime = current.totalEncodeTime !== undefined && previous.totalEncodeTime !== undefined
    ? current.totalEncodeTime - previous.totalEncodeTime : undefined;
  return {
    bitrateKbps: bytes !== undefined && bytes >= 0 ? Math.round(bytes * 8 / elapsed) : undefined,
    fps: frames !== undefined && frames >= 0 ? frames * 1000 / elapsed : undefined,
    encodeMs: frames !== undefined && frames > 0 && encodeTime !== undefined && encodeTime >= 0
      ? encodeTime * 1000 / frames : undefined,
  };
}

export function initialScreenAdaptation() {
  return { level: 0, badSamples: 0, goodSamples: 0, lastChange: 0 };
}

export function adaptScreenStream(
  state: ReturnType<typeof initialScreenAdaptation>,
  sample: { now: number; active: boolean; limitation?: string; freshRttMs?: number },
) {
  if (!sample.active) return { ...state, badSamples: 0, goodSamples: 0 };
  const bad = sample.limitation === "bandwidth" || sample.limitation === "cpu" ||
    (sample.freshRttMs !== undefined && sample.freshRttMs > 500);
  const good = (sample.limitation === "none" || sample.limitation === undefined) &&
    sample.freshRttMs !== undefined && sample.freshRttMs < 200;
  const hasObservation = bad || sample.freshRttMs !== undefined;
  const next = {
    ...state,
    badSamples: bad ? state.badSamples + 1 : hasObservation ? 0 : state.badSamples,
    goodSamples: good ? state.goodSamples + 1 : hasObservation ? 0 : state.goodSamples,
  };
  // Two degraded samples trigger a step down; recovery needs five fresh good
  // RTT observations. Cooldowns avoid fighting the browser's congestion control.
  if (next.badSamples >= 2 && sample.now - state.lastChange >= 6000 && state.level < 4) {
    return { level: state.level + 1, badSamples: 0, goodSamples: 0, lastChange: sample.now };
  }
  if (next.goodSamples >= 5 && sample.now - state.lastChange >= 20000 && state.level > 0) {
    return { level: state.level - 1, badSamples: 0, goodSamples: 0, lastChange: sample.now };
  }
  return next;
}

export function screenAdaptationParameters(settings: ScreenShareQualitySettings, level: number) {
  return {
    maxBitrateKbps: Math.min(settings.bitrateKbps, Math.max(500, Math.round(settings.bitrateKbps * 0.75 ** level))),
    maxFramerate: level >= 3 ? Math.min(settings.frameRate, 30) : settings.frameRate,
    scaleResolutionDownBy: level >= 4 ? 1.5 : 1,
  };
}
