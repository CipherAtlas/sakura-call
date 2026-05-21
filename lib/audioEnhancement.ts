"use client";

export type EnhancedMicrophoneStream = {
  stream: MediaStream;
  stop: () => void;
};

const minGateGain = 0.08;
const noiseFloorSmoothing = 0.992;

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

function createSoftNoiseGate(context: AudioContext): ScriptProcessorNode {
  const gate = context.createScriptProcessor(1024, 1, 1);
  let gateGain = 1;
  let noiseFloor = 0.0045;

  gate.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    const rms = calculateRms(input);

    if (rms < 0.024) {
      noiseFloor = noiseFloor * noiseFloorSmoothing + rms * (1 - noiseFloorSmoothing);
    }

    const threshold = Math.max(0.014, noiseFloor * 3.4);
    const fullyOpenAt = threshold * 2.25;
    const openRatio = Math.max(
      0,
      Math.min(1, (rms - threshold) / Math.max(fullyOpenAt - threshold, 0.001))
    );
    const curvedOpenRatio = openRatio * openRatio;
    const targetGain =
      rms <= threshold
        ? minGateGain
        : Math.min(1, minGateGain + curvedOpenRatio * (1 - minGateGain));
    const smoothing = targetGain > gateGain ? 0.34 : 0.045;

    gateGain += (targetGain - gateGain) * smoothing;

    for (let index = 0; index < input.length; index += 1) {
      output[index] = (input[index] ?? 0) * gateGain;
    }
  };

  return gate;
}

function createFallback(rawStream: MediaStream): EnhancedMicrophoneStream {
  return {
    stream: new MediaStream(rawStream.getAudioTracks()),
    stop() {
      for (const track of rawStream.getTracks()) {
        track.stop();
      }
    }
  };
}

export async function createEnhancedMicrophoneStream(
  rawStream: MediaStream
): Promise<EnhancedMicrophoneStream> {
  const AudioContextConstructor =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextConstructor || rawStream.getAudioTracks().length === 0) {
    return createFallback(rawStream);
  }

  let context: AudioContext | null = null;

  try {
    context = new AudioContextConstructor({
      latencyHint: "interactive"
    });
    await context.resume();

    const source = context.createMediaStreamSource(rawStream);
    const highPass = context.createBiquadFilter();
    const lowPass = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    const presence = context.createGain();
    const gate = createSoftNoiseGate(context);
    const destination = context.createMediaStreamDestination();

    highPass.type = "highpass";
    highPass.frequency.value = 120;
    highPass.Q.value = 0.9;

    lowPass.type = "lowpass";
    lowPass.frequency.value = 5600;
    lowPass.Q.value = 0.85;

    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 1.8;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.24;

    presence.gain.value = 0.96;

    source
      .connect(highPass)
      .connect(lowPass)
      .connect(compressor)
      .connect(gate)
      .connect(presence)
      .connect(destination);

    const activeContext = context;

    return {
      stream: destination.stream,
      stop() {
        source.disconnect();
        highPass.disconnect();
        lowPass.disconnect();
        compressor.disconnect();
        gate.disconnect();
        presence.disconnect();
        for (const track of destination.stream.getTracks()) {
          track.stop();
        }
        for (const track of rawStream.getTracks()) {
          track.stop();
        }
        void activeContext.close().catch(() => undefined);
      }
    };
  } catch {
    void context?.close().catch(() => undefined);
    return createFallback(rawStream);
  }
}
