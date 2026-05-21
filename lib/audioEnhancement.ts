"use client";

export type EnhancedMicrophoneStream = {
  stream: MediaStream;
  stop: () => void;
};

const minGateGain = 0.32;
const noiseFloorSmoothing = 0.98;

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
  let noiseFloor = 0.006;

  gate.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    const rms = calculateRms(input);

    if (rms < 0.018) {
      noiseFloor = noiseFloor * noiseFloorSmoothing + rms * (1 - noiseFloorSmoothing);
    }

    const threshold = Math.max(0.012, noiseFloor * 2.6);
    const fullyOpenAt = threshold * 1.75;
    const targetGain =
      rms <= threshold
        ? minGateGain
        : Math.min(
            1,
            minGateGain +
              ((rms - threshold) / Math.max(fullyOpenAt - threshold, 0.001)) *
                (1 - minGateGain)
          );
    const smoothing = targetGain > gateGain ? 0.22 : 0.08;

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
    highPass.frequency.value = 85;
    highPass.Q.value = 0.7;

    lowPass.type = "lowpass";
    lowPass.frequency.value = 7800;
    lowPass.Q.value = 0.7;

    compressor.threshold.value = -28;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    presence.gain.value = 1.08;

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
