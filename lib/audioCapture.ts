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

const outputSampleRate = 16000;
const silenceThreshold = 0.012;
const silenceToFinalizeMs = 625;
const minSpeechMs = 350;
const maxUtteranceMs = 6500;
const preRollMs = 350;

function createSegmentId() {
  return crypto.randomUUID();
}

function floatTo16BitPcm(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

function downsample(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);

  for (let index = 0; index < newLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex] ?? 0;
      count += 1;
    }

    result[index] = count > 0 ? sum / count : 0;
  }

  return result;
}

function calculateRms(input: Float32Array): number {
  if (input.length === 0) {
    return 0;
  }

  let total = 0;

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] ?? 0;
    total += value * value;
  }

  return Math.sqrt(total / input.length);
}

function mergePcm(chunks: Int16Array[]): Int16Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function encodeWav(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(offset, samples[index] ?? 0, true);
    offset += 2;
  }

  return buffer;
}

export function createAudioCapture({
  stream,
  metadata,
  onSegment
}: AudioCaptureOptions): AudioCaptureController {
  let currentMetadata = metadata;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let mutedOutput: GainNode | null = null;
  let currentChunks: Int16Array[] = [];
  const preRollChunks: Int16Array[] = [];
  let segmentId = createSegmentId();
  let speechMs = 0;
  let silenceMs = 0;
  let totalMs = 0;
  let isRecording = false;

  function resetSegment() {
    currentChunks = [];
    segmentId = createSegmentId();
    speechMs = 0;
    silenceMs = 0;
    totalMs = 0;
    isRecording = false;
  }

  function emitSegment(isFinal: boolean) {
    if (currentChunks.length === 0 || speechMs < minSpeechMs) {
      return;
    }

    const samples = mergePcm(currentChunks);
    onSegment(currentMetadata, {
      audio: encodeWav(samples),
      durationMs: totalMs,
      isFinal,
      clientSegmentId: segmentId
    });

    if (isFinal) {
      resetSegment();
    }
  }

  function handleSamples(samples: Float32Array, sampleRate: number) {
    const mono16k = downsample(samples, sampleRate);
    const pcm = floatTo16BitPcm(mono16k);
    const chunkMs = (pcm.length / outputSampleRate) * 1000;
    const rms = calculateRms(mono16k);
    const hasSpeech = rms >= silenceThreshold;

    preRollChunks.push(pcm);
    let preRollDuration = preRollChunks.reduce(
      (sum, chunk) => sum + (chunk.length / outputSampleRate) * 1000,
      0
    );

    while (preRollDuration > preRollMs && preRollChunks.length > 1) {
      const removed = preRollChunks.shift();
      preRollDuration -= ((removed?.length ?? 0) / outputSampleRate) * 1000;
    }

    if (!isRecording && hasSpeech) {
      isRecording = true;
      currentChunks = [...preRollChunks];
      const initialMs = currentChunks.reduce(
        (sum, chunk) => sum + (chunk.length / outputSampleRate) * 1000,
        0
      );
      totalMs = initialMs;
      speechMs = chunkMs;
      silenceMs = 0;
      return;
    }

    if (!isRecording) {
      return;
    }

    currentChunks.push(pcm);
    totalMs += chunkMs;

    if (hasSpeech) {
      speechMs += chunkMs;
      silenceMs = 0;
    } else {
      silenceMs += chunkMs;
    }

    if (
      (silenceMs >= silenceToFinalizeMs && speechMs >= minSpeechMs) ||
      totalMs >= maxUtteranceMs
    ) {
      emitSegment(true);
    }
  }

  return {
    async start() {
      if (context) {
        return;
      }

      const AudioContextConstructor =
        window.AudioContext || window.webkitAudioContext;
      context = new AudioContextConstructor();
      await context.resume();

      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const channelData = event.inputBuffer.getChannelData(0);
        handleSamples(channelData, event.inputBuffer.sampleRate);
      };

      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
    },
    stop() {
      emitSegment(true);
      processor?.disconnect();
      source?.disconnect();
      mutedOutput?.disconnect();
      void context?.close();
      context = null;
      source = null;
      processor = null;
      mutedOutput = null;
      resetSegment();
    },
    updateMetadata(nextMetadata) {
      currentMetadata = nextMetadata;
    }
  };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
