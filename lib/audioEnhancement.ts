"use client";

export type EnhancedMicrophoneStream = {
  setGain: (gain: number) => void;
  setProcessing: (settings: MicrophoneProcessingSettings) => void;
  stream: MediaStream;
  stop: () => void;
};

export type MicrophoneProcessingSettings = {
  noiseGate: number;
  noiseReduction: number;
};

const defaultProcessingSettings: MicrophoneProcessingSettings = {
  noiseGate: 0.14,
  noiseReduction: 0.62,
};

const rnnoiseWorkletUrl = "/rnnoise-worklet/NoiseSuppressorWorklet";
const rnnoiseWorkletName = "NoiseSuppressorWorklet";

function clampGain(gain: number) {
  if (!Number.isFinite(gain)) {
    return 1;
  }

  return Math.min(1, Math.max(0, gain));
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeProcessingSettings(
  settings: Partial<MicrophoneProcessingSettings> | undefined,
): MicrophoneProcessingSettings {
  return {
    noiseGate: clampUnit(settings?.noiseGate ?? defaultProcessingSettings.noiseGate),
    noiseReduction: clampUnit(
      settings?.noiseReduction ?? defaultProcessingSettings.noiseReduction,
    ),
  };
}

function rmsFromByteTimeDomain(samples: Uint8Array) {
  if (samples.length === 0) {
    return 0;
  }

  let total = 0;

  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    total += centered * centered;
  }

  return Math.sqrt(total / samples.length);
}

function createSoftClipperCurve() {
  const sampleCount = 2048;
  const curve = new Float32Array(sampleCount);
  const drive = 2.15;
  const ceiling = Math.tanh(drive);

  for (let index = 0; index < sampleCount; index += 1) {
    const input = (index / (sampleCount - 1)) * 2 - 1;
    curve[index] = Math.tanh(input * drive) / ceiling;
  }

  return curve;
}

function createPassthrough(rawStream: MediaStream): EnhancedMicrophoneStream {
  return {
    setGain() {
      return undefined;
    },
    setProcessing() {
      return undefined;
    },
    stream: new MediaStream(rawStream.getAudioTracks()),
    stop() {
      for (const track of rawStream.getTracks()) {
        track.stop();
      }
    },
  };
}

async function createNoiseSuppressorNode(audioContext: AudioContext) {
  if (
    !audioContext.audioWorklet ||
    typeof AudioWorkletNode === "undefined"
  ) {
    return null;
  }

  try {
    await audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);

    return new AudioWorkletNode(audioContext, rnnoiseWorkletName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
  } catch {
    return null;
  }
}

export async function createEnhancedMicrophoneStream(
  rawStream: MediaStream,
  initialGain = 1,
  initialProcessingSettings: Partial<MicrophoneProcessingSettings> = {},
): Promise<EnhancedMicrophoneStream> {
  if (typeof window === "undefined") {
    return createPassthrough(rawStream);
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextConstructor) {
    return createPassthrough(rawStream);
  }

  let audioContext: AudioContext | null = null;

  try {
    audioContext = new AudioContextConstructor();
    const activeAudioContext = audioContext;
    const source = activeAudioContext.createMediaStreamSource(rawStream);
    const gainNode = activeAudioContext.createGain();
    const highPass = activeAudioContext.createBiquadFilter();
    const clarityPresence = activeAudioContext.createBiquadFilter();
    const lowPass = activeAudioContext.createBiquadFilter();
    const directPathGain = activeAudioContext.createGain();
    const denoiseMixGain = activeAudioContext.createGain();
    const mixBus = activeAudioContext.createGain();
    const gateGain = activeAudioContext.createGain();
    const softClipper = activeAudioContext.createWaveShaper();
    const limiter = activeAudioContext.createDynamicsCompressor();
    const outputGain = activeAudioContext.createGain();
    const analyser = activeAudioContext.createAnalyser();
    const destination = activeAudioContext.createMediaStreamDestination();
    const analyserSamples = new Uint8Array(512);
    let noiseSuppressor: AudioWorkletNode | null = null;
    let frameId = 0;
    let isStopped = false;
    let isNoiseSuppressorConnected = false;
    let processingSettings = normalizeProcessingSettings(initialProcessingSettings);
    let gateLevel = 1;
    let gateHoldUntil = 0;
    let smoothedRms = 0;

    highPass.type = "highpass";
    highPass.Q.value = 0.7;

    clarityPresence.type = "peaking";
    clarityPresence.frequency.value = 3200;
    clarityPresence.Q.value = 0.82;

    lowPass.type = "lowpass";
    lowPass.Q.value = 0.7;

    softClipper.curve = createSoftClipperCurve();
    softClipper.oversample = "4x";

    limiter.threshold.value = -15;
    limiter.knee.value = 10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;

    gainNode.gain.value = clampGain(initialGain);
    directPathGain.gain.value = 1;
    denoiseMixGain.gain.value = 0;
    mixBus.gain.value = 1;
    outputGain.gain.value = 0.96;

    function updateNoiseSuppressorConnection(reduction: number) {
      const shouldConnect = Boolean(
        noiseSuppressor && !isStopped && reduction > 0.02,
      );

      if (!noiseSuppressor || shouldConnect === isNoiseSuppressorConnected) {
        return;
      }

      try {
        if (shouldConnect) {
          lowPass.connect(noiseSuppressor);
          noiseSuppressor.connect(denoiseMixGain);
        } else {
          lowPass.disconnect(noiseSuppressor);
          noiseSuppressor.disconnect(denoiseMixGain);
        }

        isNoiseSuppressorConnected = shouldConnect;
      } catch {
        isNoiseSuppressorConnected = false;
      }
    }

    function applyProcessingSettings(settings: MicrophoneProcessingSettings) {
      const reduction = settings.noiseReduction;
      const isDenoising = Boolean(noiseSuppressor && reduction > 0.02);
      const clarityBoost = 1.15 + reduction * 1.25;

      updateNoiseSuppressorConnection(reduction);
      highPass.frequency.setTargetAtTime(
        78 + reduction * 64,
        activeAudioContext.currentTime,
        0.04,
      );
      clarityPresence.gain.setTargetAtTime(
        clarityBoost,
        activeAudioContext.currentTime,
        0.04,
      );
      lowPass.frequency.setTargetAtTime(
        12800 - reduction * 1800,
        activeAudioContext.currentTime,
        0.04,
      );
      directPathGain.gain.setTargetAtTime(
        isDenoising ? 0 : 1,
        activeAudioContext.currentTime,
        0.06,
      );
      denoiseMixGain.gain.setTargetAtTime(
        isDenoising ? 1 : 0,
        activeAudioContext.currentTime,
        0.06,
      );
      limiter.threshold.setTargetAtTime(
        -13 - reduction * 5,
        activeAudioContext.currentTime,
        0.04,
      );
      limiter.release.setTargetAtTime(
        0.16 + reduction * 0.1,
        activeAudioContext.currentTime,
        0.04,
      );
    }

    function updateGate() {
      analyser.getByteTimeDomainData(analyserSamples);

      const gateStrength = processingSettings.noiseGate;
      const rms = rmsFromByteTimeDomain(analyserSamples);
      const now = activeAudioContext.currentTime;
      smoothedRms += (rms - smoothedRms) * 0.16;

      let targetGain = 1;

      if (gateStrength > 0) {
        const openThreshold = 0.006 + gateStrength * 0.024;
        const closeThreshold = openThreshold * 0.56;
        const floorGain = Math.max(0.38, 0.82 - gateStrength * 0.44);

        if (smoothedRms >= openThreshold) {
          gateHoldUntil = now + 0.14 + gateStrength * 0.08;
          targetGain = 1;
        } else if (now < gateHoldUntil || smoothedRms >= closeThreshold) {
          targetGain = Math.max(gateLevel, 0.92);
        } else {
          const normalizedLevel = closeThreshold > 0
            ? Math.min(1, smoothedRms / closeThreshold)
            : 1;
          targetGain =
            floorGain + (1 - floorGain) * Math.sqrt(normalizedLevel);
        }
      }

      const smoothing = targetGain > gateLevel ? 0.26 : 0.045;

      gateLevel += (targetGain - gateLevel) * smoothing;
      gateGain.gain.setTargetAtTime(
        gateLevel,
        now,
        targetGain > gateLevel ? 0.012 : 0.09,
      );
      frameId = window.requestAnimationFrame(updateGate);
    }

    applyProcessingSettings(processingSettings);
    source
      .connect(gainNode)
      .connect(highPass)
      .connect(clarityPresence)
      .connect(lowPass)
      .connect(directPathGain)
      .connect(mixBus)
      .connect(gateGain)
      .connect(softClipper)
      .connect(limiter)
      .connect(outputGain)
      .connect(destination);

    denoiseMixGain.connect(mixBus);
    mixBus.connect(analyser);
    void createNoiseSuppressorNode(activeAudioContext).then((node) => {
      if (!node || isStopped) {
        try {
          node?.disconnect();
        } catch {
          return;
        }
        return;
      }

      try {
        noiseSuppressor = node;
        applyProcessingSettings(processingSettings);
      } catch {
        noiseSuppressor?.disconnect();
        noiseSuppressor = null;
        applyProcessingSettings(processingSettings);
      }
    });
    await activeAudioContext.resume().catch(() => undefined);
    frameId = window.requestAnimationFrame(updateGate);

    return {
      setGain(gain: number) {
        const nextGain = clampGain(gain);
        gainNode.gain.setTargetAtTime(
          nextGain,
          activeAudioContext.currentTime,
          0.015,
        );
      },
      setProcessing(settings: MicrophoneProcessingSettings) {
        processingSettings = normalizeProcessingSettings(settings);
        applyProcessingSettings(processingSettings);
      },
      stream: destination.stream,
      stop() {
        isStopped = true;
        window.cancelAnimationFrame(frameId);
        source.disconnect();
        gainNode.disconnect();
        highPass.disconnect();
        clarityPresence.disconnect();
        lowPass.disconnect();
        directPathGain.disconnect();
        denoiseMixGain.disconnect();
        mixBus.disconnect();
        noiseSuppressor?.disconnect();
        gateGain.disconnect();
        softClipper.disconnect();
        limiter.disconnect();
        outputGain.disconnect();
        analyser.disconnect();

        for (const track of rawStream.getTracks()) {
          track.stop();
        }

        for (const track of destination.stream.getTracks()) {
          track.stop();
        }

        void activeAudioContext.close().catch(() => undefined);
      },
    };
  } catch {
    void audioContext?.close().catch(() => undefined);
    return createPassthrough(rawStream);
  }
}
