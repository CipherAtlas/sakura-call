"use client";

export const microphoneChannelModes = ["auto", "input1", "input2", "mix"] as const;

export type MicrophoneChannelMode = (typeof microphoneChannelModes)[number];

export type MicrophoneLevelSnapshot = {
  gateGain: number;
  gateThreshold: number;
  isGateOpen: boolean;
  level: number;
  noiseFloor: number;
  noiseReduction: number;
  peak: number;
};

export type MicrophoneProcessingSettings = {
  microphoneChannelMode: MicrophoneChannelMode;
  noiseGate: number;
  noiseReduction: number;
};

type MicrophoneLevelListener = (snapshot: MicrophoneLevelSnapshot) => void;

export type EnhancedMicrophoneStream = {
  setGain: (gain: number) => void;
  setProcessing: (settings: MicrophoneProcessingSettings) => void;
  stream: MediaStream;
  stop: () => void;
  subscribeLevels: (listener: MicrophoneLevelListener) => () => void;
};

const analyserSampleCount = 1024;
const maximumInputChannels = 8;
const targetVoiceRms = 0.075;
const activeVoiceFloorRms = 0.0035;
const minimumAutoGain = 0.35;
const maximumAutoGain = 7.5;
const rnnoiseWorkletLoadTimeoutMs = 2200;
const rnnoiseWorkletName = "NoiseSuppressorWorklet";
const rnnoiseWorkletUrl = "/rnnoise-worklet/NoiseSuppressorWorklet.js";
const rnnoiseOutputLagSamples = 384;
const levelPublishIntervalMs = 80;
const meterReferenceRms = 0.18;
const minimumGateThresholdRms = 0.0045;
const maximumGateThresholdRms = 0.06;
const gateClosedMinimumGain = 0.24;
const autoChannelSwitchFloorRms = 0.012;
const autoChannelSwitchRatio = 2.2;
const autoChannelReturnRatio = 1.55;
const noiseReductionTransitionSeconds = 0.24;
const noiseReductionLevelerSettleMs = 280;
const noiseReductionLevelerGainCeiling = 1.8;
const maximumNoiseSuppressorWetGain = 0.82;
const minimumDenoisedDryBedGain = 0.14;
const defaultProcessingSettings: MicrophoneProcessingSettings = {
  microphoneChannelMode: "auto",
  noiseGate: 0.02,
  noiseReduction: 0.85,
};

function clampUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function inputGainFromControl(gain: number) {
  const value = clampUnit(gain);

  if (value <= 0) {
    return 0;
  }

  if (value <= 0.5) {
    return value / 0.5;
  }

  return 1 + (value - 0.5) * 4;
}

function normalizeMicrophoneChannelMode(
  value: unknown,
  fallback: MicrophoneChannelMode,
) {
  return microphoneChannelModes.includes(value as MicrophoneChannelMode)
    ? (value as MicrophoneChannelMode)
    : fallback;
}

function normalizeProcessingSettings(
  settings: Partial<MicrophoneProcessingSettings> | undefined =
    defaultProcessingSettings,
): MicrophoneProcessingSettings {
  return {
    microphoneChannelMode: normalizeMicrophoneChannelMode(
      settings?.microphoneChannelMode,
      defaultProcessingSettings.microphoneChannelMode,
    ),
    noiseGate: clampUnit(settings?.noiseGate ?? defaultProcessingSettings.noiseGate),
    noiseReduction: clampUnit(
      settings?.noiseReduction ?? defaultProcessingSettings.noiseReduction,
    ),
  };
}

function gateThresholdRmsFromControl(noiseGate: number) {
  const gate = clampUnit(noiseGate);

  if (gate <= 0) {
    return 0;
  }

  return (
    minimumGateThresholdRms +
    Math.pow(gate, 1.65) * (maximumGateThresholdRms - minimumGateThresholdRms)
  );
}

function meterValueFromRms(rms: number) {
  return Math.pow(clampUnit(rms / meterReferenceRms), 0.45);
}

function rnnoiseAlignmentDelaySeconds(audioContext: AudioContext) {
  return Math.min(
    0.014,
    Math.max(0.006, rnnoiseOutputLagSamples / audioContext.sampleRate),
  );
}

function inputChannelCountFromStream(rawStream: MediaStream) {
  const reportedChannelCount =
    rawStream.getAudioTracks()[0]?.getSettings().channelCount;

  if (!reportedChannelCount || !Number.isFinite(reportedChannelCount)) {
    return 2;
  }

  return Math.min(
    maximumInputChannels,
    Math.max(1, Math.round(reportedChannelCount)),
  );
}

function levelSnapshotForSettings(
  settings: MicrophoneProcessingSettings,
): MicrophoneLevelSnapshot {
  const normalizedSettings = normalizeProcessingSettings(settings);

  return {
    gateGain: 1,
    gateThreshold: meterValueFromRms(
      gateThresholdRmsFromControl(normalizedSettings.noiseGate),
    ),
    isGateOpen: normalizedSettings.noiseGate <= 0,
    level: 0,
    noiseFloor: meterValueFromRms(activeVoiceFloorRms),
    noiseReduction: normalizedSettings.noiseReduction,
    peak: 0,
  };
}

export const idleMicrophoneLevelSnapshot = levelSnapshotForSettings(
  defaultProcessingSettings,
);

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

function createPassthrough(
  rawStream: MediaStream,
  initialProcessingSettings = defaultProcessingSettings,
): EnhancedMicrophoneStream {
  let lastSnapshot = levelSnapshotForSettings(initialProcessingSettings);

  return {
    setGain() {
      return undefined;
    },
    setProcessing(settings: MicrophoneProcessingSettings) {
      lastSnapshot = levelSnapshotForSettings(settings);
    },
    stream: new MediaStream(rawStream.getAudioTracks()),
    stop() {
      for (const track of rawStream.getTracks()) {
        track.stop();
      }
    },
    subscribeLevels(listener: MicrophoneLevelListener) {
      listener(lastSnapshot);

      return () => undefined;
    },
  };
}

function configureMonoNode<T extends AudioNode>(node: T): T {
  try {
    node.channelCount = 1;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";
  } catch {
    return node;
  }

  return node;
}

async function withBrowserTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("audio-worklet-load-timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function createNoiseSuppressorNode(audioContext: AudioContext) {
  if (
    !audioContext.audioWorklet ||
    typeof window === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  ) {
    return null;
  }

  await withBrowserTimeout(
    audioContext.audioWorklet.addModule(rnnoiseWorkletUrl),
    rnnoiseWorkletLoadTimeoutMs,
  );

  return configureMonoNode(
    new AudioWorkletNode(audioContext, rnnoiseWorkletName, {
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    }),
  );
}

function disconnectNode(node: AudioNode | null) {
  try {
    node?.disconnect();
  } catch {
    return undefined;
  }

  return undefined;
}

export async function createEnhancedMicrophoneStream(
  rawStream: MediaStream,
  initialGain = 1,
  initialProcessingSettings = defaultProcessingSettings,
): Promise<EnhancedMicrophoneStream> {
  if (typeof window === "undefined") {
    return createPassthrough(rawStream, initialProcessingSettings);
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextConstructor) {
    return createPassthrough(rawStream, initialProcessingSettings);
  }

  let audioContext: AudioContext | null = null;

  try {
    audioContext = new AudioContextConstructor();
    const activeAudioContext = audioContext;
    const source = activeAudioContext.createMediaStreamSource(rawStream);
    const inputChannelCount = inputChannelCountFromStream(rawStream);
    const splitter = activeAudioContext.createChannelSplitter(maximumInputChannels);
    const monoBus = configureMonoNode(activeAudioContext.createGain());
    const channelInputGains = Array.from({ length: inputChannelCount }, () =>
      configureMonoNode(activeAudioContext.createGain()),
    );
    const channelProbeAnalysers = Array.from(
      { length: Math.min(2, inputChannelCount) },
      () => activeAudioContext.createAnalyser(),
    );
    const channelProbeSamples = channelProbeAnalysers.map(
      () => new Uint8Array(analyserSampleCount),
    );
    const inputGain = configureMonoNode(activeAudioContext.createGain());
    const immediateDryGain = configureMonoNode(activeAudioContext.createGain());
    const alignedDryDelay = configureMonoNode(
      activeAudioContext.createDelay(0.05),
    );
    const alignedDryGain = configureMonoNode(activeAudioContext.createGain());
    const rnnoiseGain = configureMonoNode(activeAudioContext.createGain());
    const suppressionMix = configureMonoNode(activeAudioContext.createGain());
    const gateGain = configureMonoNode(activeAudioContext.createGain());
    const autoGain = configureMonoNode(activeAudioContext.createGain());
    const compressor = activeAudioContext.createDynamicsCompressor();
    const limiter = activeAudioContext.createDynamicsCompressor();
    const outputGain = configureMonoNode(activeAudioContext.createGain());
    const analyser = activeAudioContext.createAnalyser();
    const destination = activeAudioContext.createMediaStreamDestination();
    const analyserSamples = new Uint8Array(analyserSampleCount);
    const levelListeners = new Set<MicrophoneLevelListener>();
    let noiseSuppressor: AudioWorkletNode | null = null;
    let processingSettings = normalizeProcessingSettings(initialProcessingSettings);
    let lastAppliedNoiseReduction = 0;
    let frameId = 0;
    let isStopped = false;
    let autoInputChannelIndex = 0;
    let currentAutoGain = 1;
    let currentGateGain = 1;
    let gateIsOpen = processingSettings.noiseGate <= 0;
    let estimatedNoiseFloorRms = activeVoiceFloorRms;
    let peakLevel = 0;
    let lastLevelPublishAt = 0;
    let levelerSettlingUntil = 0;
    let lastLevelSnapshot = levelSnapshotForSettings(processingSettings);

    configureMonoNode(compressor);
    configureMonoNode(limiter);

    for (const channelGain of channelInputGains) {
      channelGain.gain.value = 0;
    }

    for (const channelProbeAnalyser of channelProbeAnalysers) {
      channelProbeAnalyser.fftSize = analyserSampleCount;
      channelProbeAnalyser.smoothingTimeConstant = 0.4;
    }

    inputGain.gain.value = inputGainFromControl(initialGain);
    immediateDryGain.gain.value = 1;
    alignedDryDelay.delayTime.value =
      rnnoiseAlignmentDelaySeconds(activeAudioContext);
    alignedDryGain.gain.value = 0;
    rnnoiseGain.gain.value = 0;
    gateGain.gain.value = currentGateGain;
    autoGain.gain.value = currentAutoGain;
    outputGain.gain.value = 0.9;

    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;

    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.055;

    analyser.fftSize = analyserSampleCount;
    analyser.smoothingTimeConstant = 0.62;

    source.connect(splitter);

    for (let index = 0; index < inputChannelCount; index += 1) {
      try {
        splitter.connect(channelInputGains[index], index);
        channelInputGains[index].connect(monoBus);

        if (channelProbeAnalysers[index]) {
          splitter.connect(channelProbeAnalysers[index], index);
        }
      } catch {
        break;
      }
    }

    monoBus.connect(inputGain);
    inputGain.connect(analyser);
    inputGain.connect(immediateDryGain).connect(suppressionMix);
    inputGain.connect(alignedDryDelay).connect(alignedDryGain).connect(suppressionMix);

    suppressionMix
      .connect(gateGain)
      .connect(autoGain)
      .connect(compressor)
      .connect(limiter)
      .connect(outputGain)
      .connect(destination);

    function publishLevelSnapshot(snapshot: MicrophoneLevelSnapshot) {
      lastLevelSnapshot = snapshot;

      for (const listener of levelListeners) {
        listener(snapshot);
      }
    }

    function applyInputChannelMode(rampTime = 0.025) {
      const mode = processingSettings.microphoneChannelMode;
      const mixGain =
        channelInputGains.length > 0 ? 1 / Math.sqrt(channelInputGains.length) : 1;
      const safeAutoChannelIndex =
        autoInputChannelIndex < channelInputGains.length ? autoInputChannelIndex : 0;

      channelInputGains.forEach((channelGain, index) => {
        let targetGain = 0;

        if (mode === "mix") {
          targetGain = mixGain;
        } else if (mode === "input1") {
          targetGain = index === 0 ? 1 : 0;
        } else if (mode === "input2") {
          targetGain =
            index === (channelInputGains.length > 1 ? 1 : 0) ? 1 : 0;
        } else {
          targetGain = index === safeAutoChannelIndex ? 1 : 0;
        }

        channelGain.gain.setTargetAtTime(
          targetGain,
          activeAudioContext.currentTime,
          rampTime,
        );
      });
    }

    function rampSuppressionGain(
      audioParam: AudioParam,
      targetValue: number,
      durationSeconds: number,
    ) {
      const now = activeAudioContext.currentTime;

      if (typeof audioParam.cancelAndHoldAtTime === "function") {
        audioParam.cancelAndHoldAtTime(now);
      } else {
        const currentValue = audioParam.value;
        audioParam.cancelScheduledValues(now);
        audioParam.setValueAtTime(currentValue, now);
      }

      if (durationSeconds <= 0.005) {
        audioParam.setValueAtTime(targetValue, now);
        return;
      }

      audioParam.linearRampToValueAtTime(targetValue, now + durationSeconds);
    }

    function updateAutoInputChannel() {
      if (
        processingSettings.microphoneChannelMode !== "auto" ||
        channelProbeAnalysers.length < 2
      ) {
        return;
      }

      const channelRms = channelProbeAnalysers.map((channelProbeAnalyser, index) => {
        channelProbeAnalyser.getByteTimeDomainData(channelProbeSamples[index]);
        return rmsFromByteTimeDomain(channelProbeSamples[index]);
      });
      const [inputOneRms, inputTwoRms] = channelRms;
      const shouldUseInputTwo =
        autoInputChannelIndex === 0 &&
        inputTwoRms > autoChannelSwitchFloorRms &&
        inputTwoRms > inputOneRms * autoChannelSwitchRatio;
      const shouldReturnToInputOne =
        autoInputChannelIndex === 1 &&
        inputOneRms > autoChannelSwitchFloorRms &&
        inputOneRms > inputTwoRms * autoChannelReturnRatio;

      if (shouldUseInputTwo) {
        autoInputChannelIndex = 1;
        applyInputChannelMode();
      } else if (shouldReturnToInputOne) {
        autoInputChannelIndex = 0;
        applyInputChannelMode();
      }
    }

    function applyProcessingSettings(
      settings: MicrophoneProcessingSettings,
      rampTime = 0.04,
    ) {
      const nextSettings = normalizeProcessingSettings(settings);
      const nextAppliedNoiseReduction = noiseSuppressor
        ? nextSettings.noiseReduction
        : 0;
      const noiseReductionChanged =
        Math.abs(nextAppliedNoiseReduction - lastAppliedNoiseReduction) > 0.01;

      processingSettings = nextSettings;
      applyInputChannelMode(rampTime);

      const reduction = nextAppliedNoiseReduction;
      const isDenoising = reduction > 0.02;
      const suppressionRampTime = noiseReductionChanged
        ? noiseReductionTransitionSeconds
        : rampTime;
      const wetGain = isDenoising
        ? Math.min(
            maximumNoiseSuppressorWetGain,
            0.16 + Math.pow(reduction, 0.78) * 0.68,
          )
        : 0;
      const alignedDryBedGain = isDenoising
        ? Math.max(
            minimumDenoisedDryBedGain,
            0.1 + Math.pow(1 - reduction, 1.25) * 0.56,
          )
        : 0;
      const immediateDryBedGain = isDenoising ? 0 : 1;

      if (noiseReductionChanged) {
        const now =
          typeof performance === "undefined" ? Date.now() : performance.now();
        levelerSettlingUntil = Math.max(
          levelerSettlingUntil,
          now + noiseReductionLevelerSettleMs,
        );
        currentAutoGain = Math.min(
          currentAutoGain,
          noiseReductionLevelerGainCeiling,
        );
        autoGain.gain.setTargetAtTime(
          currentAutoGain,
          activeAudioContext.currentTime,
          0.12,
        );
      }

      rampSuppressionGain(
        immediateDryGain.gain,
        immediateDryBedGain,
        suppressionRampTime,
      );
      rampSuppressionGain(
        alignedDryGain.gain,
        alignedDryBedGain,
        suppressionRampTime,
      );
      rampSuppressionGain(
        rnnoiseGain.gain,
        wetGain,
        suppressionRampTime,
      );
      lastAppliedNoiseReduction = reduction;
      publishLevelSnapshot({
        ...lastLevelSnapshot,
        gateThreshold: meterValueFromRms(
          gateThresholdRmsFromControl(processingSettings.noiseGate),
        ),
        isGateOpen: processingSettings.noiseGate <= 0 || gateIsOpen,
        noiseReduction: reduction,
      });
    }

    function attachNoiseSuppressor(node: AudioWorkletNode | null) {
      if (!node || isStopped) {
        disconnectNode(node);
        return;
      }

      try {
        noiseSuppressor = node;
        inputGain.connect(node).connect(rnnoiseGain).connect(suppressionMix);
        applyProcessingSettings(processingSettings);
      } catch {
        disconnectNode(node);
        noiseSuppressor = null;
        applyProcessingSettings(processingSettings);
      }
    }

    function updateLeveler(now: number) {
      if (isStopped) {
        return;
      }

      updateAutoInputChannel();
      analyser.getByteTimeDomainData(analyserSamples);

      const rms = rmsFromByteTimeDomain(analyserSamples);
      const gateThresholdRms = gateThresholdRmsFromControl(
        processingSettings.noiseGate,
      );
      const isGateEnabled = processingSettings.noiseGate > 0;

      if (isGateEnabled) {
        const closeThresholdRms = gateThresholdRms * 0.68;

        gateIsOpen = gateIsOpen
          ? rms > closeThresholdRms
          : rms >= gateThresholdRms;
      } else {
        gateIsOpen = true;
      }

      if (!gateIsOpen || rms <= Math.max(activeVoiceFloorRms, gateThresholdRms * 0.72)) {
        estimatedNoiseFloorRms += (rms - estimatedNoiseFloorRms) * 0.04;
      } else {
        estimatedNoiseFloorRms +=
          (Math.min(estimatedNoiseFloorRms, activeVoiceFloorRms) -
            estimatedNoiseFloorRms) *
          0.004;
      }

      estimatedNoiseFloorRms = Math.min(
        maximumGateThresholdRms,
        Math.max(0.0006, estimatedNoiseFloorRms),
      );

      const closedGateGain = Math.max(
        gateClosedMinimumGain,
        0.5 - processingSettings.noiseGate * 0.2,
      );
      const targetGateGain = isGateEnabled && !gateIsOpen ? closedGateGain : 1;
      currentGateGain +=
        (targetGateGain - currentGateGain) *
        (targetGateGain < currentGateGain ? 0.16 : 0.38);
      gateGain.gain.setTargetAtTime(
        currentGateGain,
        activeAudioContext.currentTime,
        targetGateGain < currentGateGain ? 0.045 : 0.014,
      );

      let targetGain = 1;
      const voiceRms = isGateEnabled && !gateIsOpen ? 0 : rms;

      if (voiceRms > activeVoiceFloorRms) {
        targetGain = Math.min(
          maximumAutoGain,
          Math.max(minimumAutoGain, targetVoiceRms / voiceRms),
        );
      } else {
        targetGain = Math.min(currentAutoGain, 1.35);
      }

      const isLevelerSettling = now < levelerSettlingUntil;

      if (isLevelerSettling && targetGain > currentAutoGain) {
        targetGain = Math.min(targetGain, Math.max(currentAutoGain, 1.15));
      }

      const smoothing = isLevelerSettling
        ? targetGain < currentAutoGain
          ? 0.18
          : 0.012
        : targetGain < currentAutoGain
          ? 0.22
          : 0.035;
      currentAutoGain += (targetGain - currentAutoGain) * smoothing;
      autoGain.gain.setTargetAtTime(
        currentAutoGain,
        activeAudioContext.currentTime,
        isLevelerSettling ? 0.16 : targetGain < currentAutoGain ? 0.025 : 0.14,
      );

      if (now - lastLevelPublishAt >= levelPublishIntervalMs) {
        const level = meterValueFromRms(rms);
        peakLevel = Math.max(level, peakLevel * 0.9);
        lastLevelPublishAt = now;
        publishLevelSnapshot({
          gateGain: currentGateGain,
          gateThreshold: meterValueFromRms(gateThresholdRms),
          isGateOpen: !isGateEnabled || gateIsOpen,
          level,
          noiseFloor: meterValueFromRms(estimatedNoiseFloorRms),
          noiseReduction: noiseSuppressor ? processingSettings.noiseReduction : 0,
          peak: peakLevel,
        });
      }

      frameId = window.requestAnimationFrame(updateLeveler);
    }

    applyProcessingSettings(processingSettings, 0.01);
    void createNoiseSuppressorNode(activeAudioContext)
      .then(attachNoiseSuppressor)
      .catch(() => {
        if (!isStopped) {
          noiseSuppressor = null;
          applyProcessingSettings(processingSettings);
        }
      });
    void activeAudioContext.resume().catch(() => undefined);
    frameId = window.requestAnimationFrame(updateLeveler);

    if (destination.stream.getAudioTracks().length === 0) {
      throw new Error("processed-microphone-unavailable");
    }

    return {
      setGain(gain: number) {
        inputGain.gain.setTargetAtTime(
          inputGainFromControl(gain),
          activeAudioContext.currentTime,
          0.015,
        );
      },
      setProcessing(settings: MicrophoneProcessingSettings) {
        applyProcessingSettings(settings);
      },
      stream: destination.stream,
      stop() {
        isStopped = true;
        window.cancelAnimationFrame(frameId);
        levelListeners.clear();
        disconnectNode(source);
        disconnectNode(splitter);
        disconnectNode(monoBus);
        for (const channelInputGain of channelInputGains) {
          disconnectNode(channelInputGain);
        }
        for (const channelProbeAnalyser of channelProbeAnalysers) {
          disconnectNode(channelProbeAnalyser);
        }
        disconnectNode(inputGain);
        disconnectNode(immediateDryGain);
        disconnectNode(alignedDryDelay);
        disconnectNode(alignedDryGain);
        disconnectNode(noiseSuppressor);
        disconnectNode(rnnoiseGain);
        disconnectNode(suppressionMix);
        disconnectNode(gateGain);
        disconnectNode(autoGain);
        disconnectNode(compressor);
        disconnectNode(limiter);
        disconnectNode(outputGain);
        disconnectNode(analyser);

        for (const track of rawStream.getTracks()) {
          track.stop();
        }

        for (const track of destination.stream.getTracks()) {
          track.stop();
        }

        void activeAudioContext.close().catch(() => undefined);
      },
      subscribeLevels(listener: MicrophoneLevelListener) {
        levelListeners.add(listener);
        listener(lastLevelSnapshot);

        return () => {
          levelListeners.delete(listener);
        };
      },
    };
  } catch {
    void audioContext?.close().catch(() => undefined);
    return createPassthrough(rawStream, initialProcessingSettings);
  }
}
