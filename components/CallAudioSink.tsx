"use client";

import { useEffect, useRef } from "react";

type BoostedAudioPlaybackController = {
  audioContext: AudioContext;
  compressor: DynamicsCompressorNode;
  destination: MediaStreamAudioDestinationNode;
  gain: GainNode;
  limiter: DynamicsCompressorNode;
  receiverPlayback: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  sourceStream: MediaStream;
  trackSignature: string;
};
const boostedAudioPlaybackControllers =
  new WeakMap<HTMLAudioElement, BoostedAudioPlaybackController>();
export function getAudioContextConstructor() {
  if (typeof window === "undefined") {
    return null;
  }

  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

function audioTrackSignature(stream: MediaStream | null) {
  return (
    stream
      ?.getAudioTracks()
      .map((track) => `${track.id}:${track.readyState}`)
      .join("|") ?? ""
  );
}

function playbackGainFromVolume(volume: number, maximumGain: number) {
  const clampedVolume = Math.min(1, Math.max(0, volume));
  const safeMaximumGain = Math.max(1, maximumGain);

  if (clampedVolume <= 0) {
    return 0;
  }

  if (clampedVolume <= 0.75) {
    return clampedVolume / 0.75;
  }

  return (
    1 +
    ((clampedVolume - 0.75) / 0.25) *
      (safeMaximumGain - 1)
  );
}

export function releaseBoostedAudioPlayback(audio: HTMLAudioElement) {
  const controller = boostedAudioPlaybackControllers.get(audio);

  if (!controller) {
    return;
  }

  boostedAudioPlaybackControllers.delete(audio);
  audio.srcObject = null;
  controller.receiverPlayback.pause();
  controller.receiverPlayback.srcObject = null;

  for (const track of controller.destination.stream.getTracks()) {
    track.stop();
  }

  controller.source.disconnect();
  controller.gain.disconnect();
  controller.compressor.disconnect();
  controller.limiter.disconnect();
  void controller.audioContext.close().catch(() => undefined);
}

function createBoostedAudioPlayback(
  audio: HTMLAudioElement,
  stream: MediaStream,
): BoostedAudioPlaybackController | null {
  const AudioContextConstructor = getAudioContextConstructor();

  if (!AudioContextConstructor || stream.getAudioTracks().length === 0) {
    return null;
  }

  try {
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const gain = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    const limiter = audioContext.createDynamicsCompressor();
    const destination = audioContext.createMediaStreamDestination();
    // Chromium needs native playback to decode remote WebRTC audio for Web Audio.
    const receiverPlayback = new Audio();
    receiverPlayback.srcObject = stream;
    receiverPlayback.muted = true;
    receiverPlayback.autoplay = true;
    receiverPlayback.setAttribute("playsinline", "");

    gain.gain.value = 1;
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 2.6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.045;

    source.connect(gain).connect(compressor).connect(limiter).connect(destination);

    const controller: BoostedAudioPlaybackController = {
      audioContext,
      compressor,
      destination,
      gain,
      limiter,
      receiverPlayback,
      source,
      sourceStream: stream,
      trackSignature: audioTrackSignature(stream),
    };

    boostedAudioPlaybackControllers.set(audio, controller);
    return controller;
  } catch {
    return null;
  }
}

function applyBoostedAudioPlayback(
  audio: HTMLAudioElement,
  stream: MediaStream,
  volume: number,
  maximumGain: number,
) {
  const trackSignature = audioTrackSignature(stream);
  let controller = boostedAudioPlaybackControllers.get(audio) ?? null;

  if (
    controller &&
    (controller.sourceStream !== stream ||
      controller.trackSignature !== trackSignature)
  ) {
    releaseBoostedAudioPlayback(audio);
    controller = null;
  }

  if (!controller) {
    controller = createBoostedAudioPlayback(audio, stream);
  }

  if (!controller) {
    return false;
  }

  const gain = playbackGainFromVolume(volume, maximumGain);

  controller.gain.gain.setTargetAtTime(
    gain,
    controller.audioContext.currentTime,
    0.018,
  );
  void controller.audioContext.resume().catch(() => undefined);
  void controller.receiverPlayback.play().catch(() => undefined);

  if (audio.srcObject !== controller.destination.stream) {
    audio.srcObject = controller.destination.stream;
  }

  audio.volume = 1;

  if (controller.audioContext.state === "running") {
    return true;
  }

  releaseBoostedAudioPlayback(audio);
  return false;
}

export function attachStreamToAudio(
  audio: HTMLAudioElement | null,
  stream: MediaStream | null,
  volume = 1,
  muted = false,
  outputDeviceId = "",
  maximumGain = 1,
) {
  if (!audio) {
    return;
  }

  const safeVolume = muted ? 0 : Math.min(1, Math.max(0, volume));
  const shouldBoost =
    stream !== null &&
    stream.getAudioTracks().length > 0 &&
    maximumGain > 1;

  if (
    !shouldBoost ||
    !stream ||
    !applyBoostedAudioPlayback(audio, stream, safeVolume, maximumGain)
  ) {
    releaseBoostedAudioPlayback(audio);

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }

    audio.volume = safeVolume;
  }

  audio.muted = muted;
  applyAudioOutputDevice(audio, outputDeviceId);

  if (stream) {
    void audio.play().catch(() => undefined);
  }
}

export function CallAudioSink({
  maximumGain,
  muted,
  outputDeviceId,
  participantId,
  stream,
  type,
  volume,
}: {
  maximumGain: number;
  muted: boolean;
  outputDeviceId: string;
  participantId: string;
  stream: MediaStream;
  type: "participant" | "screen";
  volume: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackSignature = audioTrackSignature(stream);

  useEffect(() => {
    const audio = audioRef.current;

    return () => {
      if (audio) {
        releaseBoostedAudioPlayback(audio);
      }
    };
  }, []);

  useEffect(() => {
    function syncPlayback() {
      attachStreamToAudio(
        audioRef.current,
        stream,
        volume,
        muted,
        outputDeviceId,
        maximumGain,
      );
    }
    function retryPlayback() {
      const audio = audioRef.current;
      if (audio && (audio.paused || boostedAudioPlaybackControllers.get(audio)?.audioContext.state === "suspended")) {
        syncPlayback();
      }
    }
    syncPlayback();
    stream.addEventListener("addtrack", syncPlayback);
    stream.addEventListener("removetrack", syncPlayback);
    const tracks = stream.getAudioTracks();
    for (const track of tracks) track.addEventListener("unmute", syncPlayback);
    document.addEventListener("pointerdown", retryPlayback);
    document.addEventListener("keydown", retryPlayback);
    return () => {
      stream.removeEventListener("addtrack", syncPlayback);
      stream.removeEventListener("removetrack", syncPlayback);
      for (const track of tracks) track.removeEventListener("unmute", syncPlayback);
      document.removeEventListener("pointerdown", retryPlayback);
      document.removeEventListener("keydown", retryPlayback);
    };
  }, [maximumGain, muted, outputDeviceId, stream, trackSignature, volume]);

  const dataAttributes =
    type === "screen"
      ? { "data-screen-audio-participant-id": participantId }
      : { "data-participant-id": participantId };

  return <audio ref={audioRef} {...dataAttributes} autoPlay playsInline />;
}

export function canSelectAudioOutputDevice() {
  if (typeof document === "undefined") {
    return false;
  }

  return (
    typeof (document.createElement("audio") as HTMLAudioElementWithSinkId)
      .setSinkId === "function"
  );
}

export function applyAudioOutputDevice(
  audio: HTMLAudioElement | null,
  outputDeviceId: string,
) {
  if (!audio) {
    return;
  }

  const outputAudio = audio as HTMLAudioElementWithSinkId;

  if (
    typeof outputAudio.setSinkId !== "function" ||
    outputAudio.sinkId === outputDeviceId
  ) {
    return;
  }

  void outputAudio.setSinkId(outputDeviceId).catch(() => undefined);
}


export type HTMLAudioElementWithSinkId = HTMLAudioElement & {
  sinkId?: string;
  setSinkId?: (sinkId: string) => Promise<void>;
};
