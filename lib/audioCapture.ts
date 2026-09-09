"use client";

import type { Language } from "@/lib/i18n";

export type AudioSegment = {
  audio: ArrayBuffer;
  durationMs: number;
  isFinal: boolean;
  clientSegmentId: string;
};

export type AudioCaptureMetadata = {
  roomId: string;
  participantId: string;
  spokenLanguage: Language;
};

export type AudioCaptureController = {
  start: () => Promise<void>;
  stop: () => void;
  updateMetadata: (metadata: AudioCaptureMetadata) => void;
};

type AudioCaptureOptions = {
  stream: MediaStream;
  metadata: AudioCaptureMetadata;
  onSegment: (metadata: AudioCaptureMetadata, segment: AudioSegment) => void;
};

export function createAudioCapture({
  stream,
  metadata,
  onSegment
}: AudioCaptureOptions): AudioCaptureController {
  let currentMetadata = metadata;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioWorkletNode | null = null;
  let mutedOutput: GainNode | null = null;

  function stop() {
    if (processor) {
      processor.port.onmessage = null;
      processor.port.close();
      processor.disconnect();
    }
    source?.disconnect();
    mutedOutput?.disconnect();
    void context?.close().catch(() => undefined);
    context = null;
    source = null;
    processor = null;
    mutedOutput = null;
  }

  return {
    async start() {
      if (context) return;
      const nextContext = new AudioContext();
      context = nextContext;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await nextContext.resume();
            if (context === nextContext) {
              await nextContext.audioWorklet.addModule("/worklets/caption-capture.js");
            }
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("caption-worklet-timeout")), 5000);
          })
        ]);
        if (context !== nextContext) return;
        source = nextContext.createMediaStreamSource(stream);
        processor = new AudioWorkletNode(nextContext, "sakura-caption-capture");
        processor.port.onmessage = (event: MessageEvent<{ audio: ArrayBuffer; durationMs: number }>) => {
          if (context !== nextContext) return;
          onSegment(currentMetadata, {
            ...event.data,
            isFinal: true,
            clientSegmentId: crypto.randomUUID()
          });
        };
        mutedOutput = nextContext.createGain();
        mutedOutput.gain.value = 0;
        source.connect(processor);
        processor.connect(mutedOutput);
        mutedOutput.connect(nextContext.destination);
      } catch (error) {
        if (context !== nextContext) return;
        stop();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    // Discard unfinished speech when captions stop; never submit audio after stop.
    stop,
    updateMetadata(nextMetadata) {
      currentMetadata = nextMetadata;
    }
  };
}
