"use client";

import {
  screenSharePresetDefaults,
  type ScreenSharePresetId,
  type ScreenShareQualitySettings,
} from "@/lib/screenShareQuality";

import { captionPipMessageId, appendCaptionPipMessage, drawCaptionVideoPipCanvas, renderCaptionPipWindow } from "@/lib/captionPictureInPicture";
import type { CaptionPipMessage, WindowWithDocumentPictureInPicture, VideoPictureInPictureElement, DocumentWithVideoPictureInPicture, CaptionVideoPipController } from "@/lib/captionPictureInPicture";

import {
  ArrowLeft,
  Camera,
  CameraOff,
  Captions,
  ChevronDown,
  ChevronUp,
  Copy,
  Flower2,
  MessageSquare,
  Mic,
  MicOff,
  PanelTopClose,
  PanelTopOpen,
  PictureInPicture2,
  Settings,
  SlidersHorizontal,
  Volume2,
  X,
} from "lucide-react";
import type { HTMLAudioElementWithSinkId } from "@/components/CallAudioSink";
import { attachStreamToAudio, CallAudioSink, canSelectAudioOutputDevice, applyAudioOutputDevice } from "@/components/CallAudioSink";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  type CSSProperties,
  Dispatch,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CallRoomModals,
  mediaLayoutModes,
  screenShareResolutionOptions,
} from "@/components/CallRoomModals";
import { DeviceMenu } from "@/components/DeviceMenu";
import { CallControls } from "@/components/CallControls";
import { useDialogFocus } from "@/components/useDialogFocus";
import { LanguageGate } from "@/components/LanguageGate";
import { FileTransfers } from "@/lib/fileTransfer";
import { upsertChatMessage, fileSizeLimit, type ChatMessage } from "@/lib/chat";
import { CaptionEvent, ConversationPanel } from "@/components/SubtitlesPanel";
import { UsernameGate } from "@/components/UsernameGate";
import { VideoGrid } from "@/components/VideoGrid";
import type {
  MediaLayoutMode,
  MediaSurfacePlacement,
  MediaSurface,
  MediaSurfaceId,
} from "@/components/VideoGrid";
import { createAudioCapture, AudioCaptureController } from "@/lib/audioCapture";
import {
  createEnhancedMicrophoneStream,
  defaultMicrophoneProcessingSettings,
  idleMicrophoneLevelSnapshot,
  microphoneChannelModes,
} from "@/lib/audioEnhancement";
import type {
  MicrophoneChannelMode,
  MicrophoneLevelSnapshot,
  MicrophoneProcessingSettings,
} from "@/lib/audioEnhancement";
import {
  clearSavedLanguage,
  isSupportedLanguage,
  supportedLanguageOptions,
  getSavedDisplayName,
  getSavedLanguage,
  Language,
  saveDisplayName,
  saveLanguage,
  t,
} from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import {
  getSavedParticipantSessionTokenForRoom,
  getSavedRoomCodeForRoom,
  saveParticipantSessionTokenForRoom,
} from "@/lib/roomCode";
import { getSocket } from "@/lib/socket";
import { configureCallAudioDescription } from "@/lib/webrtcAudio";
import { preferScreenH264, screenEncodingRates, initialScreenAdaptation, adaptScreenStream, screenAdaptationParameters } from "@/lib/screenShareStreaming";
import type { ScreenShareStatsSnapshot, ScreenEncodingSample } from "@/lib/screenShareStreaming";
import {
  applyTheme,
  getSavedTheme,
  saveTheme,
  ThemeMode,
  watchSystemTheme,
} from "@/lib/theme";
import {
  addStreamTracks,
  closePeerConnection,
  createPeerConnection,
  refreshPeerConnectionIceServers,
} from "@/lib/webrtc";

type PublicParticipant = {
  participantId: string;
  displayName: string;
  spokenLanguage: Language;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt: number;
};

type RoomInfo = {
  roomId: string;
  exists: boolean;
  isCreator: boolean;
  maxParticipants: number;
  participantCount: number;
  subtitleServiceStarted: boolean;
  activeScreenShareParticipantId?: string;
  roomCode?: string;
};

type JoinResponse =
  | {
      ok: true;
      activeScreenShareParticipantId?: string;
      maxParticipants: number;
      participant: PublicParticipant;
      participantCount: number;
      otherParticipants: PublicParticipant[];
      isCreator: boolean;
      subtitleServiceStarted: boolean;
      participantSessionToken: string;
    }
  | {
      ok: false;
      reason:
        | "ROOM_NOT_FOUND"
        | "INVALID_CODE"
        | "TOO_MANY_ATTEMPTS"
        | "ROOM_FULL"
        | "INVALID_SESSION"
        | "INVALID_LANGUAGE";
      blockedUntil?: number;
    };

type JoinFailureReason = Extract<JoinResponse, { ok: false }>["reason"];

type TurnPhase =
  | "disabled"
  | "ready"
  | "error";

type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  provider?: string;
  host?: string;
  expiresAt?: number;
  updatedAt: number;
};

type CallState =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "disconnected";

type SpeakingMonitor = {
  analyser: AnalyserNode;
  audioContext: AudioContext;
  frameId: number;
  source: MediaStreamAudioSourceNode;
};

type RemoteParticipantState = PublicParticipant & {
  audioStream: MediaStream;
  cameraStream: MediaStream;
  hasScreenShare: boolean;
  hasVideo: boolean;
  isSpeaking: boolean;
  screenAudioStream: MediaStream;
  screenStream: MediaStream;
  screenStreamId: string;
};

type PeerConnectionState = {
  peerConnection: RTCPeerConnection;
  pendingIceCandidates: RTCIceCandidateInit[];
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  needsNegotiation: boolean;
  needsIceRestart: boolean;
  turnFallbackAttempted: boolean;
  turnFallbackIceServersPromise: Promise<boolean> | null;
  turnFallbackTimerId: number | null;
  turnFallbackEnabled: boolean;
  screenSender: RTCRtpSender | null;
};

type StopScreenShareOptions = {
  emit?: boolean;
  renegotiate?: boolean;
};

type StopScreenShareFn = (options?: StopScreenShareOptions) => Promise<void>;

type ScreenShareConnectionPath = "direct" | "relay" | "unknown";
type ConnectionPathSummary = ScreenShareConnectionPath | "mixed";
type FullscreenConversationMode = "visible" | "overlay" | "hidden";
type ConversationDisplayMode = "panel" | "overlay" | "hidden";
type ConversationModeOption = ConversationDisplayMode | "alwaysOnTop";
type ConversationModeMenuPlacement = "dock" | "fullscreen";
type ConversationModeMenuPosition = {
  arrowLeft: number;
  left: number;
  top: number;
  width: number;
};
type FullscreenConversationOffset = {
  x: number;
  y: number;
};
type FullscreenConversationDragState = {
  originX: number;
  originY: number;
  pointerId: number;
  startX: number;
  startY: number;
};
type PeerConnectionPathSnapshot = {
  displayName: string;
  participantId: string;
  path: ScreenShareConnectionPath;
  roundTripMs?: number;
  updatedAt: number;
};

type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "system" | "window";
};

const captionLogLimit = 80;
const mediaRequestTimeoutMs = 9000;
const turnFallbackIceTimeoutMs = 8000;
const turnFallbackDisconnectedTimeoutMs = 3000;
const mediaLayoutStorageKey = "sakura.mediaLayoutMode";
const fullscreenConversationModeStorageKey =
  "sakura.fullscreenConversationMode";
const localInputVolumeStorageKey = "sakura.localInputVolume";
const masterOutputVolumeStorageKey = "sakura.masterOutputVolume";
const remoteVolumeStorageKey = "sakura.remoteVolumes";
const screenShareAudioVolumeStorageKey = "sakura.screenShareAudioVolume";
const audioOutputDeviceStorageKey = "sakura.audioOutputDeviceId";
const microphoneDeviceStorageKey = "sakura.microphoneDeviceId";
const voiceSettingsStorageKey = "sakura.voiceSettings";
const noiseReductionCommitDelayMs = 180;
const defaultVoiceSettings = defaultMicrophoneProcessingSettings;
const defaultLocalInputVolume = 0.5;
const defaultMasterOutputVolume = 1;
const defaultScreenShareAudioVolume = 1;
const remoteAudioMaximumOutputGain = 1;
const screenShareAudioMaximumOutputGain = 1;
type MediaPreparationStep =
  | "idle"
  | "microphone"
  | "microphoneFallback"
  | "voice"
  | "camera";
const mediaPreparationStatusKeys: Record<MediaPreparationStep, TranslationKey> = {
  camera: "preparingCamera",
  idle: "preparingPermissions",
  microphone: "preparingMicrophone",
  microphoneFallback: "preparingDefaultMicrophone",
  voice: "preparingVoice",
};
const initialFullscreenConversationOffset: FullscreenConversationOffset = {
  x: 0,
  y: 0,
};
const defaultScreenShareQuality = screenSharePresetDefaults.detail;

function isMediaLayoutMode(value: unknown): value is MediaLayoutMode {
  return (
    typeof value === "string" &&
    mediaLayoutModes.includes(value as MediaLayoutMode)
  );
}

function getSavedMediaLayoutMode(): MediaLayoutMode {
  if (typeof window === "undefined") {
    return "gallery";
  }

  const savedMode = window.localStorage.getItem(mediaLayoutStorageKey);
  return isMediaLayoutMode(savedMode) ? savedMode : "gallery";
}

function saveMediaLayoutMode(mode: MediaLayoutMode) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(mediaLayoutStorageKey, mode);
  }
}

function saveFullscreenConversationMode(mode: FullscreenConversationMode) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(fullscreenConversationModeStorageKey, mode);
  }
}

function getSavedVolume(key: string, fallback = 1) {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(1, Math.max(0, fallback))
    : 1;

  if (typeof window === "undefined") {
    return safeFallback;
  }

  const savedValue = window.localStorage.getItem(key);

  if (savedValue === null) {
    return safeFallback;
  }

  const value = Number(savedValue);

  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : safeFallback;
}

function saveVolume(key: string, volume: number) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(key, String(Math.min(1, Math.max(0, volume))));
  }
}

function getSavedRemoteVolumes(): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(remoteVolumeStorageKey) ?? "{}",
    ) as Record<string, unknown>;

    return Object.fromEntries(
      Object.entries(parsed).map(([participantId, value]): [string, number] => [
        participantId,
        typeof value === "number" && Number.isFinite(value)
          ? Math.min(1, Math.max(0, value))
          : 1,
      ]),
    );
  } catch {
    return {};
  }
}

function saveRemoteVolumes(volumes: Record<string, number>) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(remoteVolumeStorageKey, JSON.stringify(volumes));
  }
}

function getSavedAudioOutputDeviceId() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(audioOutputDeviceStorageKey) ?? "";
}

function saveAudioOutputDeviceId(deviceId: string) {
  if (typeof window !== "undefined") {
    if (deviceId) {
      window.localStorage.setItem(audioOutputDeviceStorageKey, deviceId);
    } else {
      window.localStorage.removeItem(audioOutputDeviceStorageKey);
    }
  }
}

function clampVoiceSetting(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function isMicrophoneChannelMode(value: unknown): value is MicrophoneChannelMode {
  return microphoneChannelModes.includes(value as MicrophoneChannelMode);
}

function getSavedVoiceSettings(): MicrophoneProcessingSettings {
  if (typeof window === "undefined") {
    return defaultVoiceSettings;
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(voiceSettingsStorageKey) ?? "{}",
    ) as Record<string, unknown>;

    return {
      microphoneChannelMode: isMicrophoneChannelMode(parsed.microphoneChannelMode)
        ? parsed.microphoneChannelMode
        : defaultVoiceSettings.microphoneChannelMode,
      noiseGate: clampVoiceSetting(
        parsed.noiseGate,
        defaultVoiceSettings.noiseGate,
      ),
      noiseReduction: clampVoiceSetting(
        parsed.noiseReduction,
        defaultVoiceSettings.noiseReduction,
      ),
    };
  } catch {
    return defaultVoiceSettings;
  }
}

function saveVoiceSettings(settings: MicrophoneProcessingSettings) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      voiceSettingsStorageKey,
      JSON.stringify({
        microphoneChannelMode: isMicrophoneChannelMode(
          settings.microphoneChannelMode,
        )
          ? settings.microphoneChannelMode
          : defaultVoiceSettings.microphoneChannelMode,
        noiseGate: Math.min(1, Math.max(0, settings.noiseGate)),
        noiseReduction: Math.min(1, Math.max(0, settings.noiseReduction)),
      }),
    );
  }
}

function getSavedMicrophoneDeviceId() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(microphoneDeviceStorageKey) ?? "";
}

function saveMicrophoneDeviceId(deviceId: string) {
  if (typeof window !== "undefined") {
    if (deviceId) {
      window.localStorage.setItem(microphoneDeviceStorageKey, deviceId);
    } else {
      window.localStorage.removeItem(microphoneDeviceStorageKey);
    }
  }
}

const browserProcessingBypassDevicePatterns = [
  "aggregate",
  "apollo",
  "audient",
  "behringer",
  "blackhole",
  "clarett",
  "evo",
  "focusrite",
  "loopback",
  "m-audio",
  "motu",
  "obs",
  "presonus",
  "rode",
  "rode caster",
  "rodecaster",
  "scarlett",
  "shure",
  "soundflower",
  "steinberg",
  "tascam",
  "umc",
  "virtual",
  "volt",
];

function shouldBypassBrowserMicrophoneProcessing(deviceLabel: string) {
  const normalizedLabel = deviceLabel.trim().toLowerCase();

  return Boolean(
    normalizedLabel &&
      browserProcessingBypassDevicePatterns.some((pattern) =>
        normalizedLabel.includes(pattern),
      ),
  );
}

function getMicrophoneDeviceLabel(
  devices: MediaDeviceInfo[],
  deviceId: string,
) {
  if (!deviceId) {
    return "";
  }

  return devices.find((device) => device.deviceId === deviceId)?.label ?? "";
}

function browserMicrophoneProcessingConstraints(deviceLabel: string) {
  const bypassBrowserProcessing =
    shouldBypassBrowserMicrophoneProcessing(deviceLabel);

  return {
    autoGainControl: false,
    echoCancellation: !bypassBrowserProcessing,
    noiseSuppression: false,
  };
}

function microphoneChannelCountConstraint(
  deviceLabel: string,
  channelMode: MicrophoneChannelMode,
) {
  if (
    channelMode !== "auto" ||
    shouldBypassBrowserMicrophoneProcessing(deviceLabel)
  ) {
    return { ideal: 2 };
  }

  return { ideal: 1 };
}

function stopMediaStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function isPermissionDeniedMediaError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

async function getUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  let didTimeout = false;
  let timeoutId: number | undefined;
  const mediaRequest = navigator.mediaDevices.getUserMedia(constraints);
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      didTimeout = true;
      reject(new Error("media-request-timeout"));
    }, mediaRequestTimeoutMs);
  });

  void mediaRequest.then((stream) => {
    if (didTimeout) {
      stopMediaStream(stream);
    }
  }, () => undefined);

  try {
    return await Promise.race([mediaRequest, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function applyMicrophoneTrackConstraints(
  track: MediaStreamTrack,
  deviceLabel: string,
  channelMode: MicrophoneChannelMode,
) {
  void track
    .applyConstraints({
      ...browserMicrophoneProcessingConstraints(deviceLabel),
      channelCount: microphoneChannelCountConstraint(deviceLabel, channelMode),
    })
    .catch(() => undefined);
}

function microphoneConstraints(
  deviceId: string,
  deviceLabel: string,
  channelMode: MicrophoneChannelMode,
): MediaTrackConstraints {
  return {
    ...browserMicrophoneProcessingConstraints(deviceLabel),
    channelCount: microphoneChannelCountConstraint(deviceLabel, channelMode),
    deviceId: deviceId ? { exact: deviceId } : undefined,
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
  };
}

function microphoneChannelModeLabel(
  language: Language,
  mode: MicrophoneChannelMode,
) {
  switch (mode) {
    case "auto":
      return t(language, "microphoneChannelAuto");
    case "input1":
      return t(language, "microphoneChannelInput1");
    case "input2":
      return t(language, "microphoneChannelInput2");
    case "mix":
      return t(language, "microphoneChannelMix");
  }
}

function stopSpeakingMonitor(
  monitorRef: MutableRefObject<SpeakingMonitor | null>,
  speakingRef: MutableRefObject<boolean>,
  setSpeaking: Dispatch<SetStateAction<boolean>>,
) {
  const monitor = monitorRef.current;

  if (monitor) {
    window.cancelAnimationFrame(monitor.frameId);
    monitor.source.disconnect();
    monitor.analyser.disconnect();
    void monitor.audioContext.close().catch(() => undefined);
    monitorRef.current = null;
  }

  speakingRef.current = false;
  setSpeaking(false);
}

function startSpeakingMonitor({
  monitorRef,
  quietFramesToStop = 20,
  setSpeaking,
  speakingRef,
  stream,
  threshold = 0.025,
}: {
  monitorRef: MutableRefObject<SpeakingMonitor | null>;
  quietFramesToStop?: number;
  setSpeaking: Dispatch<SetStateAction<boolean>>;
  speakingRef: MutableRefObject<boolean>;
  stream: MediaStream;
  threshold?: number;
}) {
  stopSpeakingMonitor(monitorRef, speakingRef, setSpeaking);

  const AudioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  const audioTracks = stream
    .getAudioTracks()
    .filter((track) => track.readyState === "live");

  if (!AudioContextConstructor || audioTracks.length === 0) {
    return;
  }

  const audioContext = new AudioContextConstructor();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
  let speakingFrames = 0;
  let quietFrames = 0;

  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  const samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  void audioContext.resume().catch(() => undefined);

  function setNextSpeaking(nextValue: boolean) {
    if (speakingRef.current === nextValue) {
      return;
    }

    speakingRef.current = nextValue;
    setSpeaking(nextValue);
  }

  const monitor: SpeakingMonitor = {
    analyser,
    audioContext,
    frameId: 0,
    source,
  };

  function tick() {
    analyser.getByteTimeDomainData(samples);

    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }

    const rms = Math.sqrt(sum / samples.length);

    if (rms > threshold) {
      speakingFrames += 1;
      quietFrames = 0;
    } else {
      quietFrames += 1;
      speakingFrames = 0;
    }

    if (speakingFrames >= 2) {
      setNextSpeaking(true);
    }

    if (quietFrames >= quietFramesToStop) {
      setNextSpeaking(false);
    }

    if (monitorRef.current === monitor) {
      monitor.frameId = window.requestAnimationFrame(tick);
    }
  }

  monitorRef.current = monitor;
  monitor.frameId = window.requestAnimationFrame(tick);
}

function getSessionParticipantId() {
  if (typeof window === "undefined") {
    return "";
  }

  const storageKey = "jec.participantId";
  const existing = window.sessionStorage.getItem(storageKey);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, next);
  return next;
}

function errorForJoinReason(language: Language, reason: JoinFailureReason) {
  if (reason === "INVALID_CODE") {
    return t(language, "invalidCode");
  }

  if (reason === "TOO_MANY_ATTEMPTS") {
    return t(language, "codeBlocked");
  }

  if (reason === "ROOM_FULL") {
    return t(language, "roomFull");
  }

  if (reason === "INVALID_LANGUAGE") {
    return t(language, "invalidLanguage");
  }

  return t(language, "roomNotFound");
}

function hasLiveAudioTrack(stream: MediaStream | null): stream is MediaStream {
  return (
    stream?.getAudioTracks().some((track) => track.readyState === "live") ??
    false
  );
}

function hasLiveVideoTrack(stream: MediaStream | null): stream is MediaStream {
  return (
    stream?.getVideoTracks().some((track) => track.readyState === "live") ??
    false
  );
}

function appendCaptionLog(log: CaptionEvent[], caption: CaptionEvent) {
  return [
    ...log.filter(
      (item) =>
        item.timestamp !== caption.timestamp ||
        item.speakerId !== caption.speakerId,
    ),
    caption,
  ].slice(-captionLogLimit);
}

function attachStreamToVideo(video: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!video) {
    return;
  }

  video.onloadedmetadata = null;
  video.oncanplay = null;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  if (stream) {
    const playVideo = () => {
      void video.play().catch(() => undefined);
    };

    video.onloadedmetadata = playVideo;
    video.oncanplay = playVideo;
    playVideo();
  }
}

function screenShareDisplayMediaOptions(
  settings: ScreenShareQualitySettings,
): ExtendedDisplayMediaOptions {
  return {
    audio: {
      autoGainControl: false,
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
    },
    selfBrowserSurface: "include",
    surfaceSwitching: "include",
    systemAudio: "include",
    video: screenShareConstraints(settings),
    windowAudio: "system",
  };
}


function clampQualityNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function screenShareConstraints(
  settings: ScreenShareQualitySettings,
): MediaTrackConstraints {
  return {
    frameRate: {
      ideal: settings.frameRate,
      max: settings.frameRate,
    },
    height: { ideal: settings.height, max: settings.height },
    width: { ideal: settings.width, max: settings.width },
  };
}

async function tuneSenderEncoding(
  sender: RTCRtpSender,
  {
    degradationPreference,
    maxBitrateKbps,
    maxFramerate,
    scaleResolutionDownBy = 1,
  }: {
    degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution";
    maxBitrateKbps?: number;
    maxFramerate?: number;
    scaleResolutionDownBy?: number;
  },
) {
  try {
    const parameters = sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution";
    };
    parameters.encodings =
      parameters.encodings && parameters.encodings.length > 0
        ? parameters.encodings
        : [{}];

    const nextEncoding = {
      ...parameters.encodings[0],
      scaleResolutionDownBy,
    };

    if (maxBitrateKbps) {
      nextEncoding.maxBitrate = maxBitrateKbps * 1000;
    } else {
      delete nextEncoding.maxBitrate;
    }

    if (maxFramerate) {
      nextEncoding.maxFramerate = maxFramerate;
    } else {
      delete nextEncoding.maxFramerate;
    }

    parameters.encodings[0] = nextEncoding;

    if (degradationPreference) {
      parameters.degradationPreference = degradationPreference;
    }

    await sender.setParameters(parameters);
    return true;
  } catch (error) {
    console.warn("Video sender settings could not be applied", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

function findSenderForTrack(
  peerConnection: RTCPeerConnection | null,
  track: MediaStreamTrack | null,
) {
  if (!peerConnection || !track) {
    return null;
  }

  return (
    peerConnection.getSenders().find((sender) => sender.track?.id === track.id) ??
    null
  );
}

function clearTurnFallbackTimer(peerState: PeerConnectionState) {
  if (peerState.turnFallbackTimerId !== null) {
    window.clearTimeout(peerState.turnFallbackTimerId);
    peerState.turnFallbackTimerId = null;
  }
}

function hasConnectedIcePath(peerConnection: RTCPeerConnection) {
  return (
    peerConnection.connectionState === "connected" ||
    peerConnection.iceConnectionState === "connected" ||
    peerConnection.iceConnectionState === "completed"
  );
}

function isRelayOnlyPeerConnection(peerConnection: RTCPeerConnection) {
  return peerConnection.getConfiguration().iceTransportPolicy === "relay";
}

function reportNumber(report: RTCStats | Record<string, unknown>, key: string) {
  const value = (report as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function reportString(report: RTCStats | Record<string, unknown>, key: string) {
  const value = (report as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getSelectedConnectionPath(stats: RTCStatsReport): {
  path: ScreenShareConnectionPath;
  roundTripMs?: number;
  roundTripMeasurements?: number;
} {
  let selectedPairId = "";
  let selectedPair: RTCStats | null = null;

  stats.forEach((report) => {
    if (report.type === "transport") {
      selectedPairId = reportString(report, "selectedCandidatePairId") ?? "";
    }
  });

  if (selectedPairId) {
    selectedPair = stats.get(selectedPairId) ?? null;
  }

  const candidatePairs: RTCStats[] = [];

  stats.forEach((report) => {
    if (
      !selectedPair &&
      report.type === "candidate-pair" &&
      reportString(report, "state") === "succeeded" &&
      ((report as unknown as Record<string, unknown>).selected === true ||
        (report as unknown as Record<string, unknown>).nominated === true)
    ) {
      candidatePairs.push(report);
    }
  });

  if (!selectedPair && candidatePairs.length > 0) {
    selectedPair = candidatePairs.sort((first, second) => {
      const firstSelected =
        (first as unknown as Record<string, unknown>).selected === true ? 1 : 0;
      const secondSelected =
        (second as unknown as Record<string, unknown>).selected === true ? 1 : 0;
      const firstBytes =
        (reportNumber(first, "bytesSent") ?? 0) +
        (reportNumber(first, "bytesReceived") ?? 0);
      const secondBytes =
        (reportNumber(second, "bytesSent") ?? 0) +
        (reportNumber(second, "bytesReceived") ?? 0);

      return secondSelected - firstSelected || secondBytes - firstBytes;
    })[0];
  }

  if (!selectedPair) {
    return { path: "unknown" };
  }

  const localCandidate = stats.get(reportString(selectedPair, "localCandidateId") ?? "");
  const remoteCandidate = stats.get(
    reportString(selectedPair, "remoteCandidateId") ?? "",
  );
  const localType = localCandidate
    ? reportString(localCandidate, "candidateType")
    : undefined;
  const remoteType = remoteCandidate
    ? reportString(remoteCandidate, "candidateType")
    : undefined;
  const roundTrip = reportNumber(selectedPair, "currentRoundTripTime");

  return {
    path: localType === "relay" || remoteType === "relay" ? "relay" : "direct",
    roundTripMs: roundTrip !== undefined ? Math.round(roundTrip * 1000) : undefined,
    roundTripMeasurements: reportNumber(selectedPair, "responsesReceived"),
  };
}

function summarizeConnectionPath(
  snapshots: PeerConnectionPathSnapshot[],
  expectedPeerCount: number,
): ConnectionPathSummary {
  if (expectedPeerCount === 0 || snapshots.length === 0) {
    return "unknown";
  }

  const paths = snapshots.map((snapshot) => snapshot.path);
  const hasRelay = paths.includes("relay");
  const hasDirect = paths.includes("direct");
  const hasUnknown = paths.includes("unknown");

  if (hasRelay && (hasDirect || hasUnknown || snapshots.length < expectedPeerCount)) {
    return "mixed";
  }

  if (hasRelay) {
    return "relay";
  }

  if (!hasUnknown && paths.length === expectedPeerCount) {
    return "direct";
  }

  return "unknown";
}

function createRemoteParticipant(participant: PublicParticipant): RemoteParticipantState {
  return {
    ...participant,
    audioStream: new MediaStream(),
    cameraStream: new MediaStream(),
    hasScreenShare: false,
    hasVideo: false,
    isSpeaking: false,
    screenAudioStream: new MediaStream(),
    screenStream: new MediaStream(),
    screenStreamId: "",
  };
}

function participantSurfaceId(participantId: string) {
  return `participant:${participantId}`;
}

function screenSurfaceId(participantId: string) {
  return `screen:${participantId}`;
}

type SurfacePickerTarget = {
  scope: "call" | "fullscreen";
  slot: MediaSurfacePlacement;
  surfaceId: MediaSurfaceId;
};

function orderMediaSurfaces(
  surfaces: MediaSurface[],
  surfaceOrder: MediaSurfaceId[],
) {
  const surfacePosition = new Map(
    surfaceOrder.map((surfaceId, index) => [surfaceId, index]),
  );

  return surfaces
    .map((surface, index) => ({
      index,
      position: surfacePosition.get(surface.id) ?? Number.MAX_SAFE_INTEGER,
      surface,
    }))
    .sort((left, right) => left.position - right.position || left.index - right.index)
    .map(({ surface }) => surface);
}

function swapSurfaceOrder(
  currentOrder: MediaSurfaceId[],
  surfaces: MediaSurface[],
  targetSurfaceId: MediaSurfaceId,
  selectedSurfaceId: MediaSurfaceId,
) {
  const surfaceIds = surfaces.map((surface) => surface.id);
  const nextOrder = [
    ...currentOrder.filter((surfaceId) => surfaceIds.includes(surfaceId)),
    ...surfaceIds.filter((surfaceId) => !currentOrder.includes(surfaceId)),
  ];
  const targetIndex = nextOrder.indexOf(targetSurfaceId);
  const selectedIndex = nextOrder.indexOf(selectedSurfaceId);

  if (targetIndex === -1 || selectedIndex === -1) {
    return nextOrder;
  }

  [nextOrder[targetIndex], nextOrder[selectedIndex]] = [
    nextOrder[selectedIndex],
    nextOrder[targetIndex],
  ];

  return nextOrder;
}

function activeDominantSurfaceId(
  surfaces: MediaSurface[],
  dominantSurfaceId: MediaSurfaceId | null,
  layoutMode: MediaLayoutMode,
) {
  const availableSurfaces = surfaces.filter(
    (surface) => surface.stream || surface.kind === "participant",
  );
  const screenSurface = availableSurfaces.find((surface) => surface.kind === "screen");
  const participantSurfaces = availableSurfaces.filter(
    (surface) => surface.kind === "participant",
  );
  const selectedSurface = availableSurfaces.find(
    (surface) => surface.id === dominantSurfaceId,
  );

  if (screenSurface) {
    return (selectedSurface ?? screenSurface).id;
  }

  const selectedParticipant =
    selectedSurface?.kind === "participant" ? selectedSurface : null;
  const speakingSurface = participantSurfaces.find((surface) => surface.isSpeaking);
  const effectiveLayoutMode =
    participantSurfaces.length > 1 ? layoutMode : "gallery";

  if (
    (effectiveLayoutMode !== "focus" && effectiveLayoutMode !== "speaker") ||
    participantSurfaces.length === 0
  ) {
    return null;
  }

  return (
    (effectiveLayoutMode === "speaker"
      ? speakingSurface ?? selectedParticipant ?? participantSurfaces[0]
      : selectedParticipant ?? speakingSurface ?? participantSurfaces[0]
    ).id
  );
}

export function CallRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const socket = useMemo(() => getSocket(), []);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const fullscreenShellRef = useRef<HTMLElement>(null);
  const conversationOverlayRef = useRef<HTMLElement>(null);
  const conversationOverlayDragRef =
    useRef<FullscreenConversationDragState | null>(null);
  const fullscreenConversationRef = useRef<HTMLElement>(null);
  const fullscreenConversationDragRef =
    useRef<FullscreenConversationDragState | null>(null);
  const captionPipWindowRef = useRef<Window | null>(null);
  const captionVideoPipRef = useRef<CaptionVideoPipController | null>(null);
  const volumeButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenVolumeButtonRef = useRef<HTMLButtonElement>(null);
  const volumeMixerRef = useRef<HTMLDivElement>(null);
  const dockConversationModeButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenConversationModeButtonRef = useRef<HTMLButtonElement>(null);
  const conversationModeMenuRef = useRef<HTMLDivElement>(null);
  const audioCaptureRef = useRef<AudioCaptureController | null>(null);
  const audioEnhancementStopRef = useRef<(() => void) | null>(null);
  const audioInputGainRef = useRef<((gain: number) => void) | null>(null);
  const audioInputProcessingRef =
    useRef<((settings: MicrophoneProcessingSettings) => void) | null>(null);
  const audioLevelUnsubscribeRef = useRef<(() => void) | null>(null);
  const pendingNoiseReductionTimeoutRef = useRef<number | null>(null);
  const pendingNoiseReductionValueRef = useRef<number | null>(null);
  const rawMicrophoneStreamRef = useRef<MediaStream | null>(null);
  const selfMonitorAudioRef = useRef<HTMLAudioElement>(null);
  const selfMonitorStreamRef = useRef<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string>("");
  const participantSessionTokenRef = useRef("");
  const roomCodeRef = useRef("");
  const languageRef = useRef<Language>("en");
  const displayNameRef = useRef("");
  const roomEndRedirectTimeoutRef = useRef<number | null>(null);
  const hasEndedCallRef = useRef(false);
  const speakingMonitorRef = useRef<SpeakingMonitor | null>(null);
  const isLocalSpeakingRef = useRef(false);
  const remoteSpeakingMonitorsRef = useRef<Map<string, SpeakingMonitor>>(new Map());
  const remoteSpeakingValuesRef = useRef<Map<string, boolean>>(new Map());
  const peerConnectionsRef = useRef<Map<string, PeerConnectionState>>(new Map());
  const remoteTrackStreamIdsRef = useRef<Map<string, Map<string, string>>>(
    new Map(),
  );
  const remoteScreenStreamIdsRef = useRef<Map<string, string>>(new Map());

  const stopScreenShareRef = useRef<StopScreenShareFn>(async () => undefined);
  const deafenRestoreMutedRef = useRef<boolean | null>(null);
  const micTestRestoreRef = useRef<{
    deafenRestoreMuted: boolean | null;
    isDeafened: boolean;
    isMuted: boolean;
  } | null>(null);
  const stopMicrophoneTestRef = useRef<() => void>(() => undefined);

  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState("");
  const [mediaNotice, setMediaNotice] = useState("");

  useEffect(() => {
    if (!mediaNotice) return;
    const timer = window.setTimeout(() => setMediaNotice(""), 5_000);
    return () => window.clearTimeout(timer);
  }, [mediaNotice]);
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let restingHeight = viewport?.height ?? window.innerHeight;
    let restingWidth = window.innerWidth;
    let keyboardOpen = false;
    function updateViewport() {
      if (viewport && viewport.scale !== 1) return;
      root.style.setProperty("--call-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty("--call-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      const editing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      const height = viewport?.height ?? window.innerHeight;
      if (Math.abs(window.innerWidth - restingWidth) > 100) {
        restingWidth = window.innerWidth;
        restingHeight = window.innerHeight;
      }
      if (!editing) restingHeight = Math.max(restingHeight, height);
      keyboardOpen = (editing || keyboardOpen) && Math.max(restingHeight, window.innerHeight) - height > 100;
      root.toggleAttribute("data-call-keyboard", keyboardOpen);
    }
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    document.addEventListener("focusin", updateViewport);
    document.addEventListener("focusout", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.removeEventListener("focusin", updateViewport);
      document.removeEventListener("focusout", updateViewport);
      root.style.removeProperty("--call-viewport-height");
      root.style.removeProperty("--call-viewport-top");
      root.removeAttribute("data-call-keyboard");
    };
  }, []);

  const [isCodeCopied, setIsCodeCopied] = useState(false);
  const [showMoreControls, setShowMoreControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [showScreenShareSettings, setShowScreenShareSettings] = useState(false);
  const [showLayoutPicker, setShowLayoutPicker] = useState(false);
  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [showVolumeMixer, setShowVolumeMixer] = useState(false);
  const [showConversationModeMenu, setShowConversationModeMenu] = useState(false);
  const [conversationModeMenuPlacement, setConversationModeMenuPlacement] =
    useState<ConversationModeMenuPlacement>("dock");
  const [conversationModeMenuPosition, setConversationModeMenuPosition] =
    useState<ConversationModeMenuPosition | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getSavedTheme());
  const [conversationDisplayMode, setConversationDisplayMode] =
    useState<ConversationDisplayMode>("panel");
  const [fullscreenConversationMode, setFullscreenConversationMode] =
    useState<FullscreenConversationMode>("visible");
  const [conversationOverlayOffset, setConversationOverlayOffset] =
    useState<FullscreenConversationOffset>(initialFullscreenConversationOffset);
  const [fullscreenConversationOffset, setFullscreenConversationOffset] =
    useState<FullscreenConversationOffset>(initialFullscreenConversationOffset);
  const [isFullscreenToolbarOpen, setIsFullscreenToolbarOpen] = useState(true);
  const [isFullscreenBottomBarVisible, setIsFullscreenBottomBarVisible] =
    useState(true);
  const [isCaptionPipSupported, setIsCaptionPipSupported] = useState(false);
  const [isCaptionPipOpen, setIsCaptionPipOpen] = useState(false);
  const [surfacePickerTarget, setSurfacePickerTarget] =
    useState<SurfacePickerTarget | null>(null);
  const [localInputVolume, setLocalInputVolume] = useState(() =>
    getSavedVolume(localInputVolumeStorageKey, defaultLocalInputVolume),
  );
  const [masterOutputVolume, setMasterOutputVolume] = useState(() =>
    getSavedVolume(masterOutputVolumeStorageKey, defaultMasterOutputVolume),
  );
  const [screenShareAudioVolume, setScreenShareAudioVolume] = useState(() =>
    getSavedVolume(screenShareAudioVolumeStorageKey, defaultScreenShareAudioVolume),
  );
  const [remoteVolumes, setRemoteVolumes] = useState<Record<string, number>>({});
  const [voiceSettings, setVoiceSettings] = useState<MicrophoneProcessingSettings>(
    () => getSavedVoiceSettings(),
  );
  const [noiseReductionDraft, setNoiseReductionDraft] = useState(
    () => getSavedVoiceSettings().noiseReduction,
  );
  const [microphoneLevel, setMicrophoneLevel] =
    useState<MicrophoneLevelSnapshot>(idleMicrophoneLevelSnapshot);
  const [selectedMicrophoneDeviceId, setSelectedMicrophoneDeviceId] = useState(
    () => getSavedMicrophoneDeviceId(),
  );
  const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] = useState(
    () => getSavedAudioOutputDeviceId(),
  );
  const [microphoneDevices, setMicrophoneDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [isAudioOutputSelectionSupported, setIsAudioOutputSelectionSupported] =
    useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isTestingMicrophone, setIsTestingMicrophone] = useState(false);
  const [isReplacingMicrophone, setIsReplacingMicrophone] = useState(false);
  const [startWithCameraOff, setStartWithCameraOff] = useState(false);
  const [isPreparingMedia, setIsPreparingMedia] = useState(false);
  const [mediaPreparationStep, setMediaPreparationStep] =
    useState<MediaPreparationStep>("idle");
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [mediaLayoutMode, setMediaLayoutMode] =
    useState<MediaLayoutMode>("gallery");
  const [dominantSurface, setDominantSurface] = useState<MediaSurfaceId | null>(
    null,
  );
  const [surfaceOrder, setSurfaceOrder] = useState<MediaSurfaceId[]>([]);
  const [fullscreenSurface, setFullscreenSurface] = useState<MediaSurfaceId | null>(
    null,
  );
  const [isScreenShareSupported, setIsScreenShareSupported] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenShareQuality, setScreenShareQuality] =
    useState<ScreenShareQualitySettings>(defaultScreenShareQuality);
  const [activeScreenShareQuality, setActiveScreenShareQuality] =
    useState<ScreenShareQualitySettings | null>(null);
  const [isApplyingScreenQuality, setIsApplyingScreenQuality] = useState(false);
  const [screenShareStats, setScreenShareStats] =
    useState<ScreenShareStatsSnapshot | null>(null);
  const [connectionPathSnapshots, setConnectionPathSnapshots] = useState<
    Record<string, PeerConnectionPathSnapshot>
  >({});
  const [activeScreenShareParticipantId, setActiveScreenShareParticipantId] =
    useState("");
  const [remoteParticipants, setRemoteParticipants] = useState<
    Record<string, RemoteParticipantState>
  >({});
  const [isRoomHost, setIsRoomHost] = useState(false);
  const [isSubtitleServiceStarted, setIsSubtitleServiceStarted] =
    useState(false);
  const [isStartingSubtitleService, setIsStartingSubtitleService] =
    useState(false);
  const [localPartialCaption, setLocalPartialCaption] =
    useState<CaptionEvent | null>(null);
  const fileTransfersRef = useRef(new FileTransfers());
  const [attachmentDraft, setAttachmentDraft] = useState<{ id: string; name: string; size: number } | null>(null);
  const [fileError, setFileError] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, number | "failed">>({});
  const activeDownloadsRef = useRef(new Set<string>());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatSendError, setChatSendError] = useState(false);
  const chatSendingRef = useRef(false);
  const chatAttemptRef = useRef<{ text: string; id: string; attachmentId?: string } | null>(null);
  const [localCaptionLog, setLocalCaptionLog] = useState<CaptionEvent[]>([]);
  const [remoteCaptionLog, setRemoteCaptionLog] = useState<CaptionEvent[]>([]);
  function attachChatFile(file: File) {
    if (chatSendingRef.current) return;
    const id = crypto.randomUUID();
    if (file.size > fileSizeLimit || !fileTransfersRef.current.retain(id, file)) { setFileError(true); return; }
    if (attachmentDraft) fileTransfersRef.current.release(attachmentDraft.id);
    setAttachmentDraft({ id, name: file.name.slice(0, 255), size: file.size });
    setFileError(false);
  }

  function removeChatAttachment() {
    if (attachmentDraft) fileTransfersRef.current.release(attachmentDraft.id);
    setAttachmentDraft(null);
  }

  async function downloadChatFile(message: ChatMessage) {
    const attachment = message.attachment;
    const peer = peerConnectionsRef.current.get(message.speakerId)?.peerConnection;
    if (!attachment || !peer || activeDownloadsRef.current.has(message.id)) return;
    activeDownloadsRef.current.add(message.id);
    setDownloads(current => ({ ...current, [message.id]: 0 }));
    try {
      const blob = await fileTransfersRef.current.receive(peer, attachment, percent => {
        setDownloads(current => ({ ...current, [message.id]: percent }));
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownloads(current => { const next = { ...current }; delete next[message.id]; return next; });
    } catch { setDownloads(current => ({ ...current, [message.id]: "failed" })); }
    finally { activeDownloadsRef.current.delete(message.id); }
  }

  async function sendChatMessage() {
    const text = chatDraft.trim();
    if ((!text && !attachmentDraft) || chatSendingRef.current) return;
    if (!socket.connected || hasEndedCallRef.current) { setChatSendError(true); return; }
    const attempt = chatAttemptRef.current?.text === text && chatAttemptRef.current?.attachmentId === attachmentDraft?.id ? chatAttemptRef.current : { text, id: crypto.randomUUID(), attachmentId: attachmentDraft?.id };
    chatAttemptRef.current = attempt;
    chatSendingRef.current = true;
    setIsChatSending(true);
    setChatSendError(false);
    try {
      const response = await socket.timeout(5000).emitWithAck("chat:send", { text, clientMessageId: attempt.id, ...(attachmentDraft ? { attachment: attachmentDraft } : {}) });
      if (!response?.ok) throw new Error("chat-send-failed");
      setChatMessages(log => upsertChatMessage(log, response.message));
      setChatDraft(current => current.trim() === text ? "" : current);
      setAttachmentDraft(null);
      chatAttemptRef.current = null;
    } catch { setChatSendError(true); }
    finally { chatSendingRef.current = false; setIsChatSending(false); }
  }

  const [showSubtitleNotice, setShowSubtitleNotice] = useState(false);
  const [subtitleNoticeKey, setSubtitleNoticeKey] =
    useState<"subtitleServiceStartedNotice" | "subtitleServiceStoppedNotice" | "callHostLeftNotice">(
      "subtitleServiceStartedNotice",
    );
  const [subtitleNoticeId, setSubtitleNoticeId] = useState(0);
  const [turnStatus, setTurnStatus] = useState<TurnStatus | null>(null);

  const remoteParticipantsRef = useRef(remoteParticipants);
  const localInputVolumeRef = useRef(localInputVolume);
  const masterOutputVolumeRef = useRef(masterOutputVolume);
  const screenShareAudioVolumeRef = useRef(screenShareAudioVolume);
  const remoteVolumesRef = useRef(remoteVolumes);
  const voiceSettingsRef = useRef(voiceSettings);
  const selectedMicrophoneDeviceIdRef = useRef(selectedMicrophoneDeviceId);
  const selectedAudioOutputDeviceIdRef = useRef(selectedAudioOutputDeviceId);
  const microphoneDevicesRef = useRef<MediaDeviceInfo[]>([]);
  const audioOutputDevicesRef = useRef<MediaDeviceInfo[]>([]);
  const isMutedRef = useRef(isMuted);
  const isDeafenedRef = useRef(isDeafened);

  const closeCaptionPipWindow = useCallback(({ restoreOverlay = false } = {}) => {
    const pipWindow = captionPipWindowRef.current;
    const videoPip = captionVideoPipRef.current;
    captionPipWindowRef.current = null;
    captionVideoPipRef.current = null;
    setIsCaptionPipOpen(false);

    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }

    if (videoPip) {
      const pipDocument = document as DocumentWithVideoPictureInPicture;

      if (
        pipDocument.pictureInPictureElement === videoPip.video &&
        typeof pipDocument.exitPictureInPicture === "function"
      ) {
        void pipDocument.exitPictureInPicture().catch(() => undefined);
      }

      if (
        videoPip.video.webkitPresentationMode === "picture-in-picture" &&
        typeof videoPip.video.webkitSetPresentationMode === "function"
      ) {
        videoPip.video.webkitSetPresentationMode("inline");
      }

      for (const track of videoPip.stream.getTracks()) {
        track.stop();
      }

      videoPip.video.remove();
    }

    if (restoreOverlay) {
      setConversationDisplayMode((current) =>
        current === "hidden" ? "overlay" : current,
      );
      setFullscreenConversationMode((current) => {
        if (current !== "hidden") {
          return current;
        }

        saveFullscreenConversationMode("overlay");
        return "overlay";
      });
    }
  }, []);

  const updateConversationModeMenuPosition = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const anchor =
      conversationModeMenuPlacement === "fullscreen"
        ? fullscreenConversationModeButtonRef.current
        : dockConversationModeButtonRef.current;
    const menu = conversationModeMenuRef.current;

    if (!anchor || !menu) {
      return;
    }

    const viewportPadding = 8;
    const gap = 12;
    const anchorRect = anchor.getBoundingClientRect();
    const maxMenuWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
    const menuWidth = Math.min(280, maxMenuWidth);
    const menuHeight = menu.getBoundingClientRect().height || 192;
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    const left = clampNumber(
      anchorCenter - menuWidth / 2,
      viewportPadding,
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const top =
      conversationModeMenuPlacement === "fullscreen"
        ? clampNumber(
            anchorRect.bottom + gap,
            viewportPadding,
            Math.max(
              viewportPadding,
              window.innerHeight - menuHeight - viewportPadding,
            ),
          )
        : clampNumber(
            anchorRect.top - menuHeight - gap,
            viewportPadding,
            Math.max(
              viewportPadding,
              window.innerHeight - menuHeight - viewportPadding,
            ),
          );

    setConversationModeMenuPosition({
      arrowLeft: clampNumber(anchorCenter - left, 18, menuWidth - 18),
      left,
      top,
      width: menuWidth,
    });
  }, [conversationModeMenuPlacement]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const documentPictureInPicture = (
      window as WindowWithDocumentPictureInPicture
    ).documentPictureInPicture;
    const pipDocument = document as DocumentWithVideoPictureInPicture;
    const canvas = document.createElement("canvas");
    const video = document.createElement("video") as VideoPictureInPictureElement;
    const supportsVideoPip =
      typeof canvas.captureStream === "function" &&
      ((typeof video.requestPictureInPicture === "function" &&
        pipDocument.pictureInPictureEnabled !== false) ||
        typeof video.webkitSetPresentationMode === "function");

    setIsCaptionPipSupported(
      typeof documentPictureInPicture?.requestWindow === "function" ||
        supportsVideoPip,
    );
  }, []);

  useEffect(() => {
    return () => closeCaptionPipWindow();
  }, [closeCaptionPipWindow]);

  useEffect(() => {
    if (callState === "idle" || callState === "disconnected") {
      closeCaptionPipWindow();
      setShowConversationModeMenu(false);
      setConversationModeMenuPosition(null);
    }
  }, [callState, closeCaptionPipWindow]);

  useEffect(() => {
    if (!showConversationModeMenu || typeof window === "undefined") {
      return;
    }

    let frame = window.requestAnimationFrame(updateConversationModeMenuPosition);

    function schedulePositionUpdate() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateConversationModeMenuPosition);
    }

    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [
    showConversationModeMenu,
    updateConversationModeMenuPosition,
  ]);

  useEffect(() => {
    remoteParticipantsRef.current = remoteParticipants;
  }, [remoteParticipants]);

  useEffect(() => {
    localInputVolumeRef.current = localInputVolume;
    audioInputGainRef.current?.(localInputVolume);
  }, [localInputVolume]);

  useEffect(() => {
    voiceSettingsRef.current = voiceSettings;
    audioInputProcessingRef.current?.(voiceSettings);
    saveVoiceSettings(voiceSettings);

    for (const track of rawMicrophoneStreamRef.current?.getAudioTracks() ?? []) {
      const deviceLabel =
        track.label ||
        getMicrophoneDeviceLabel(
          microphoneDevicesRef.current,
          selectedMicrophoneDeviceIdRef.current,
        );
      applyMicrophoneTrackConstraints(
        track,
        deviceLabel,
        voiceSettings.microphoneChannelMode,
      );
    }
  }, [voiceSettings]);

  useEffect(() => {
    setNoiseReductionDraft(voiceSettings.noiseReduction);
  }, [voiceSettings.noiseReduction]);

  useEffect(() => {
    return () => {
      if (
        typeof window !== "undefined" &&
        pendingNoiseReductionTimeoutRef.current !== null
      ) {
        window.clearTimeout(pendingNoiseReductionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    selectedMicrophoneDeviceIdRef.current = selectedMicrophoneDeviceId;
  }, [selectedMicrophoneDeviceId]);

  useEffect(() => {
    masterOutputVolumeRef.current = masterOutputVolume;
  }, [masterOutputVolume]);

  useEffect(() => {
    screenShareAudioVolumeRef.current = screenShareAudioVolume;
  }, [screenShareAudioVolume]);

  useEffect(() => {
    remoteVolumesRef.current = remoteVolumes;
  }, [remoteVolumes]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const remoteList = useMemo(
    () =>
      Object.values(remoteParticipants).sort(
        (first, second) => first.joinedAt - second.joinedAt,
      ),
    [remoteParticipants],
  );
  const displayedVoiceSettings = useMemo(
    () => ({
      ...voiceSettings,
      noiseReduction: noiseReductionDraft,
    }),
    [noiseReductionDraft, voiceSettings],
  );
  const participantCount =
    (callState === "idle" && roomInfo ? roomInfo.participantCount : 1 + remoteList.length);
  const maxParticipants = roomInfo?.maxParticipants ?? 6;
  const hostRoomCode = roomInfo?.isCreator ? roomInfo.roomCode : undefined;
  const canManageTurnRelay = Boolean(roomInfo?.isCreator || isRoomHost);
  const turnRelayReady = turnStatus?.phase === "ready";

  const showSubtitleServiceBanner = useCallback(
    (
      noticeKey:
        | "subtitleServiceStartedNotice"
        | "subtitleServiceStoppedNotice"
        | "callHostLeftNotice",
    ) => {
      setSubtitleNoticeKey(noticeKey);
      setSubtitleNoticeId((value) => value + 1);
      setShowSubtitleNotice(true);
    },
    [],
  );

  const updateRemoteParticipant = useCallback(
    (
      participantId: string,
      updater: (participant: RemoteParticipantState) => RemoteParticipantState,
    ) => {
      setRemoteParticipants((current) => {
        const participant = current[participantId];

        if (!participant) {
          return current;
        }

        return {
          ...current,
          [participantId]: updater(participant),
        };
      });
    },
    [],
  );

  const upsertRemoteParticipant = useCallback((participant: PublicParticipant) => {
    setRemoteParticipants((current) => {
      if (participant.participantId === participantIdRef.current) {
        return current;
      }

      const existing = current[participant.participantId];

      return {
        ...current,
        [participant.participantId]: existing
          ? {
              ...existing,
              ...participant,
            }
          : createRemoteParticipant(participant),
      };
    });
  }, []);

  const removeRemoteParticipant = useCallback((participantId: string) => {
    setRemoteParticipants((current) => {
      const next = { ...current };
      delete next[participantId];
      return next;
    });
  }, []);

  const stopRemoteSpeakingMonitor = useCallback((participantId: string) => {
    const monitor = remoteSpeakingMonitorsRef.current.get(participantId);

    if (monitor) {
      window.cancelAnimationFrame(monitor.frameId);
      monitor.source.disconnect();
      monitor.analyser.disconnect();
      void monitor.audioContext.close().catch(() => undefined);
    }

    remoteSpeakingMonitorsRef.current.delete(participantId);
    remoteSpeakingValuesRef.current.delete(participantId);
    updateRemoteParticipant(participantId, (participant) => ({
      ...participant,
      isSpeaking: false,
    }));
  }, [updateRemoteParticipant]);

  const startRemoteSpeakingMonitor = useCallback(
    (participantId: string, stream: MediaStream) => {
      stopRemoteSpeakingMonitor(participantId);

      const monitorRef = {
        current: null,
      } as MutableRefObject<SpeakingMonitor | null>;
      const speakingRef = {
        current: false,
      } as MutableRefObject<boolean>;

      const setRemoteSpeaking: Dispatch<SetStateAction<boolean>> = (value) => {
        const previous = remoteSpeakingValuesRef.current.get(participantId) ?? false;
        const nextValue =
          typeof value === "function" ? value(previous) : value;
        remoteSpeakingValuesRef.current.set(participantId, nextValue);
        updateRemoteParticipant(participantId, (participant) => ({
          ...participant,
          isSpeaking: nextValue,
        }));
      };

      startSpeakingMonitor({
        monitorRef,
        quietFramesToStop: 24,
        setSpeaking: setRemoteSpeaking,
        speakingRef,
        stream,
        threshold: 0.02,
      });

      if (monitorRef.current) {
        remoteSpeakingMonitorsRef.current.set(participantId, monitorRef.current);
      }
    },
    [stopRemoteSpeakingMonitor, updateRemoteParticipant],
  );

  const stopLocalSpeakingMonitor = useCallback(() => {
    stopSpeakingMonitor(speakingMonitorRef, isLocalSpeakingRef, setIsLocalSpeaking);
  }, []);

  const startLocalSpeakingMonitor = useCallback((stream: MediaStream) => {
    startSpeakingMonitor({
      monitorRef: speakingMonitorRef,
      setSpeaking: setIsLocalSpeaking,
      speakingRef: isLocalSpeakingRef,
      stream,
    });
  }, []);

  const playRemoteAudio = useCallback(() => {
    for (const participant of Object.values(remoteParticipantsRef.current)) {
      attachStreamToAudio(
        document.querySelector<HTMLAudioElement>(
          `audio[data-participant-id="${participant.participantId}"]`,
        ),
        participant.audioStream,
        (remoteVolumesRef.current[participant.participantId] ?? 1) *
          masterOutputVolumeRef.current,
        isDeafenedRef.current,
        selectedAudioOutputDeviceIdRef.current,
        remoteAudioMaximumOutputGain,
      );
      attachStreamToAudio(
        document.querySelector<HTMLAudioElement>(
          `audio[data-screen-audio-participant-id="${participant.participantId}"]`,
        ),
        participant.screenAudioStream,
        screenShareAudioVolumeRef.current * masterOutputVolumeRef.current,
        isDeafenedRef.current,
        selectedAudioOutputDeviceIdRef.current,
        screenShareAudioMaximumOutputGain,
      );
    }
  }, []);

  useEffect(() => {
    selectedAudioOutputDeviceIdRef.current = selectedAudioOutputDeviceId;
    saveAudioOutputDeviceId(selectedAudioOutputDeviceId);
    applyAudioOutputDevice(
      selfMonitorAudioRef.current,
      selectedAudioOutputDeviceId,
    );
    playRemoteAudio();
  }, [playRemoteAudio, selectedAudioOutputDeviceId]);

  useEffect(() => {
    isDeafenedRef.current = isDeafened;

    if (isDeafened && !isMuted) {
      for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
        track.enabled = false;
      }

      isMutedRef.current = true;
      setIsMuted(true);
    }

    playRemoteAudio();
  }, [isDeafened, isMuted, playRemoteAudio]);

  const attachLocalPreview = useCallback(() => {
    const previewStream =
      localStreamRef.current && hasLiveVideoTrack(localStreamRef.current)
        ? localStreamRef.current
        : null;

    attachStreamToVideo(localVideoRef.current, previewStream);
  }, []);

  const refreshIceServersForRoom = useCallback(
    async (peerConnection: RTCPeerConnection) => {
      const participantId = participantIdRef.current;
      const participantSessionToken = participantSessionTokenRef.current;

      if (!participantId || !participantSessionToken) {
        return false;
      }

      return refreshPeerConnectionIceServers(peerConnection, {
        roomId,
        participantId,
        participantSessionToken,
      });
    },
    [roomId],
  );

  const enableTurnFallbackIceServers = useCallback(
    (peerState: PeerConnectionState) => {
      if (peerState.turnFallbackEnabled) {
        return Promise.resolve(true);
      }

      if (peerState.turnFallbackIceServersPromise) {
        return peerState.turnFallbackIceServersPromise;
      }

      const promise = refreshIceServersForRoom(peerState.peerConnection).then(
        (enabled) => {
          if (enabled) {
            peerState.turnFallbackEnabled = true;
          }

          return enabled;
        },
      );
      peerState.turnFallbackIceServersPromise = promise;
      const clearPendingPromise = () => {
        if (peerState.turnFallbackIceServersPromise === promise) {
          peerState.turnFallbackIceServersPromise = null;
        }
      };
      void promise.then(clearPendingPromise, clearPendingPromise);

      return promise;
    },
    [refreshIceServersForRoom],
  );

  const flushPendingIceCandidates = useCallback(
    async (peerState: PeerConnectionState) => {
      if (!peerState.peerConnection.remoteDescription) {
        return;
      }

      const pendingCandidates = peerState.pendingIceCandidates;
      peerState.pendingIceCandidates = [];

      for (const candidate of pendingCandidates) {
        await peerState.peerConnection.addIceCandidate(candidate).catch(() => undefined);
      }
    },
    [],
  );

  const closePeerForParticipant = useCallback(
    (participantId: string) => {
      const peerState = peerConnectionsRef.current.get(participantId);

      if (!peerState) {
        return;
      }

      clearTurnFallbackTimer(peerState);
      closePeerConnection(peerState.peerConnection);
      peerConnectionsRef.current.delete(participantId);
      remoteTrackStreamIdsRef.current.delete(participantId);
    },
    [],
  );

  const closeAllPeerConnections = useCallback(() => {
    for (const participantId of peerConnectionsRef.current.keys()) {
      closePeerForParticipant(participantId);
    }
  }, [closePeerForParticipant]);

  const removeRemotePeer = useCallback(
    (participantId: string) => {
      closePeerForParticipant(participantId);
      stopRemoteSpeakingMonitor(participantId);
      remoteScreenStreamIdsRef.current.delete(participantId);
      removeRemoteParticipant(participantId);
      setActiveScreenShareParticipantId((current) =>
        current === participantId ? "" : current,
      );
      setDominantSurface((current) =>
        current === participantSurfaceId(participantId) ||
        current === screenSurfaceId(participantId)
          ? null
          : current,
      );
      setFullscreenSurface((current) =>
        current === participantSurfaceId(participantId) ||
        current === screenSurfaceId(participantId)
          ? null
          : current,
      );
    },
    [closePeerForParticipant, removeRemoteParticipant, stopRemoteSpeakingMonitor],
  );

  const applyCameraBandwidthProfile = useCallback(
    async (peerConnection: RTCPeerConnection, prioritizeScreen: boolean) => {
      const screenTrack = localScreenStreamRef.current?.getVideoTracks()[0] ?? null;
      const cameraSenders = peerConnection
        .getSenders()
        .filter(
          (sender) =>
            sender.track?.kind === "video" && sender.track.id !== screenTrack?.id,
        );

      await Promise.all(
        cameraSenders.map((sender) =>
          tuneSenderEncoding(sender, {
            degradationPreference: prioritizeScreen
              ? "maintain-framerate"
              : "balanced",
            maxBitrateKbps: prioritizeScreen ? 350 : undefined,
            maxFramerate: prioritizeScreen ? 12 : undefined,
            scaleResolutionDownBy: prioritizeScreen ? 2 : 1,
          }),
        ),
      );
    },
    [],
  );

  const applyScreenShareQualityToTrack = useCallback(
    async (
      settings: ScreenShareQualitySettings,
      screenTrack: MediaStreamTrack,
      senders: Array<RTCRtpSender | null>,
    ) => {
      screenTrack.contentHint = settings.optimization;
      let failed = false;
      await screenTrack.applyConstraints(screenShareConstraints(settings)).catch((error) => {
        failed = true;
        console.warn("Screen capture settings could not be applied", error instanceof Error ? error.name : "UnknownError");
      });

      const applied = await Promise.all(
        senders
          .filter((sender): sender is RTCRtpSender => Boolean(sender))
          .map((sender) =>
            tuneSenderEncoding(sender, {
              degradationPreference:
                settings.optimization === "detail"
                  ? "maintain-resolution"
                  : "balanced",
              maxBitrateKbps: settings.bitrateKbps,
              maxFramerate: settings.frameRate,
              scaleResolutionDownBy: 1,
            }),
          ),
      );

      if (failed || applied.some(result => !result)) {
        setMediaNotice(t(languageRef.current, "screenQualitySettingsFailed"));
      }
      await Promise.all(
        [...peerConnectionsRef.current.values()].map((peerState) =>
          applyCameraBandwidthProfile(
            peerState.peerConnection,
            settings.prioritizeScreen,
          ),
        ),
      );
    },
    [applyCameraBandwidthProfile],
  );

  const addLocalTracksToPeer = useCallback(
    (peerState: PeerConnectionState) => {
      if (localStreamRef.current) {
        addStreamTracks(peerState.peerConnection, localStreamRef.current);
      }

      if (localScreenStreamRef.current) {
        addStreamTracks(peerState.peerConnection, localScreenStreamRef.current);
        const [screenTrack] = localScreenStreamRef.current.getVideoTracks();
        peerState.screenSender = findSenderForTrack(
          peerState.peerConnection,
          screenTrack ?? null,
        );

        if (screenTrack) {
          void applyScreenShareQualityToTrack(
            activeScreenShareQuality ?? screenShareQuality,
            screenTrack,
            [peerState.screenSender],
          );
        }
      }
    },
    [activeScreenShareQuality, applyScreenShareQualityToTrack, screenShareQuality],
  );

  const createAndSendOffer = useCallback(
    async (participantId: string, { iceRestart = false } = {}) => {
      const peerState = peerConnectionsRef.current.get(participantId);

      if (!peerState) {
        return;
      }

      if (iceRestart) {
        peerState.needsIceRestart = true;
      }

      if (
        peerState.makingOffer ||
        peerState.peerConnection.signalingState !== "stable"
      ) {
        peerState.needsNegotiation = true;
        return;
      }

      if (isRelayOnlyPeerConnection(peerState.peerConnection)) {
        await enableTurnFallbackIceServers(peerState).catch(() => false);
      }

      peerState.makingOffer = true;
      peerState.needsNegotiation = false;

      try {
        const shouldRestartIce = peerState.needsIceRestart;
        if (!preferScreenH264(peerState.peerConnection, localScreenStreamRef.current?.getVideoTracks()[0])) {
          setMediaNotice(t(languageRef.current, "screenQualitySettingsFailed"));
        }
        const offer = await peerState.peerConnection.createOffer({
          iceRestart: shouldRestartIce,
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await peerState.peerConnection.setLocalDescription(
          configureCallAudioDescription(
            offer,
            localScreenStreamRef.current?.id,
            peerState.peerConnection.remoteDescription,
          ),
        );
        peerState.needsIceRestart = false;
        socket.emit("webrtc:offer", {
          roomId,
          toParticipantId: participantId,
          description: peerState.peerConnection.localDescription,
          iceRestart: shouldRestartIce,
        });
      } finally {
        peerState.makingOffer = false;

        if (
          peerState.needsNegotiation &&
          peerState.peerConnection.signalingState === "stable"
        ) {
          void createAndSendOffer(participantId);
        }
      }
    },
    [enableTurnFallbackIceServers, roomId, socket],
  );

  const startTurnFallbackForPeer = useCallback(
    async (participantId: string) => {
      const peerState = peerConnectionsRef.current.get(participantId);

      if (
        !peerState ||
        hasEndedCallRef.current ||
        peerState.turnFallbackAttempted ||
        peerState.peerConnection.connectionState === "closed" ||
        hasConnectedIcePath(peerState.peerConnection)
      ) {
        return;
      }

      clearTurnFallbackTimer(peerState);
      peerState.turnFallbackAttempted = true;

      const enabled = await enableTurnFallbackIceServers(peerState).catch(
        () => false,
      );
      const currentPeerState = peerConnectionsRef.current.get(participantId);

      if (!enabled || currentPeerState !== peerState) {
        return;
      }

      await createAndSendOffer(participantId, { iceRestart: true });
    },
    [createAndSendOffer, enableTurnFallbackIceServers],
  );

  const scheduleTurnFallbackForPeer = useCallback(
    (participantId: string, delayMs: number) => {
      const peerState = peerConnectionsRef.current.get(participantId);

      if (
        !peerState ||
        hasEndedCallRef.current ||
        peerState.turnFallbackAttempted ||
        peerState.turnFallbackTimerId !== null ||
        peerState.peerConnection.connectionState === "closed" ||
        hasConnectedIcePath(peerState.peerConnection)
      ) {
        return;
      }

      peerState.turnFallbackTimerId = window.setTimeout(() => {
        peerState.turnFallbackTimerId = null;
        void startTurnFallbackForPeer(participantId);
      }, delayMs);
    },
    [startTurnFallbackForPeer],
  );

  const ensurePeerConnection = useCallback(
    (participantId: string) => {
      const existing = peerConnectionsRef.current.get(participantId);

      if (existing) {
        return existing;
      }

      const peerConnection = createPeerConnection();
      const peerState: PeerConnectionState = {
        peerConnection,
        pendingIceCandidates: [],
        polite: participantIdRef.current.localeCompare(participantId) > 0,
        makingOffer: false,
        ignoreOffer: false,
        needsNegotiation: false,
        needsIceRestart: false,
        turnFallbackAttempted: false,
        turnFallbackIceServersPromise: null,
        turnFallbackTimerId: null,
        turnFallbackEnabled: false,
        screenSender: null,
      };

      peerConnectionsRef.current.set(participantId, peerState);
      peerConnection.ondatachannel = event => { void fileTransfersRef.current.serve(event.channel, participantId); };

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc:ice-candidate", {
            roomId,
            toParticipantId: participantId,
            candidate: event.candidate,
          });
        }
      };

      peerConnection.onnegotiationneeded = () => {
        void createAndSendOffer(participantId);
      };

      peerConnection.onsignalingstatechange = () => {
        if (
          peerState.needsNegotiation &&
          peerConnection.signalingState === "stable"
        ) {
          void createAndSendOffer(participantId);
        }
      };

      peerConnection.ontrack = (event) => {
        const incomingStreamId = event.streams[0]?.id ?? "";
        const trackStreamIds =
          remoteTrackStreamIdsRef.current.get(participantId) ?? new Map();
        remoteTrackStreamIdsRef.current.set(participantId, trackStreamIds);

        if (event.track.kind === "audio" || event.track.kind === "video") {
          trackStreamIds.set(event.track.id, incomingStreamId);
        }

        const participant =
          remoteParticipantsRef.current[participantId] ??
          createRemoteParticipant({
            participantId,
            displayName: t(languageRef.current, "remoteVideo"),
            spokenLanguage: languageRef.current,
            isHost: false,
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          });
        const screenStreamId =
          remoteScreenStreamIdsRef.current.get(participantId) ??
          participant.screenStreamId;
        // Audio and video can arrive before React commits the first track event.
        remoteParticipantsRef.current = {
          ...remoteParticipantsRef.current,
          [participantId]: participant,
        };
        const isScreenTrack =
          Boolean(screenStreamId) && screenStreamId === incomingStreamId;
        const targetStream =
          event.track.kind === "audio"
            ? isScreenTrack
              ? participant.screenAudioStream
              : participant.audioStream
            : isScreenTrack
              ? participant.screenStream
              : participant.cameraStream;

        if (!targetStream.getTracks().some((track) => track.id === event.track.id)) {
          targetStream.addTrack(event.track);
        }

        event.track.onended = () => {
          trackStreamIds.delete(event.track.id);
          updateRemoteParticipant(participantId, (current) => {
            current.audioStream.removeTrack(event.track);
            current.screenAudioStream.removeTrack(event.track);
            current.cameraStream.removeTrack(event.track);
            current.screenStream.removeTrack(event.track);

            return {
              ...current,
              hasScreenShare: current.screenStream
                .getVideoTracks()
                .some((track) => track.readyState === "live"),
              hasVideo: current.cameraStream
                .getVideoTracks()
                .some((track) => track.readyState === "live"),
            };
          });
          window.setTimeout(playRemoteAudio, 0);
        };

        if (
          event.track.kind === "audio" &&
          targetStream === participant.audioStream &&
          participant.audioStream
            .getAudioTracks()
            .some((track) => track.readyState === "live")
        ) {
          startRemoteSpeakingMonitor(participantId, participant.audioStream);
        }

        setRemoteParticipants((current) => ({
          ...current,
          [participantId]: {
            ...participant,
            hasScreenShare: participant.screenStream
              .getVideoTracks()
              .some((track) => track.readyState === "live"),
            hasVideo: participant.cameraStream
              .getVideoTracks()
              .some((track) => track.readyState === "live"),
            screenStreamId: isScreenTrack
              ? screenStreamId
              : participant.screenStreamId,
          },
        }));
        setCallState("connected");
        window.setTimeout(playRemoteAudio, 0);
      };

      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;

        if (state === "connected" || state === "completed" || state === "closed") {
          clearTurnFallbackTimer(peerState);
        } else if (state === "checking") {
          scheduleTurnFallbackForPeer(participantId, turnFallbackIceTimeoutMs);
        } else if (state === "disconnected") {
          scheduleTurnFallbackForPeer(
            participantId,
            turnFallbackDisconnectedTimeoutMs,
          );
        } else if (state === "failed") {
          void startTurnFallbackForPeer(participantId);
        }
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;

        if (state === "connected") {
          clearTurnFallbackTimer(peerState);
          setCallState("connected");
        } else if (state === "connecting") {
          scheduleTurnFallbackForPeer(participantId, turnFallbackIceTimeoutMs);
          setCallState("connecting");
        } else if (state === "disconnected") {
          scheduleTurnFallbackForPeer(
            participantId,
            turnFallbackDisconnectedTimeoutMs,
          );
          setCallState("reconnecting");
        } else if (state === "failed" || state === "closed") {
          if (state === "failed") {
            void startTurnFallbackForPeer(participantId);
          } else {
            clearTurnFallbackTimer(peerState);
          }

          setCallState((current) =>
            current === "disconnected" ? current : "reconnecting",
          );
        }
      };

      addLocalTracksToPeer(peerState);

      return peerState;
    },
    [
      addLocalTracksToPeer,
      createAndSendOffer,
      playRemoteAudio,
      roomId,
      scheduleTurnFallbackForPeer,
      socket,
      startTurnFallbackForPeer,
      startRemoteSpeakingMonitor,
      updateRemoteParticipant,
    ],
  );

  const createOffersForAllPeers = useCallback(
    async ({ iceRestart = false } = {}) => {
      await Promise.all(
        [...peerConnectionsRef.current.keys()].map((participantId) =>
          createAndSendOffer(participantId, { iceRestart }).catch(() => undefined),
        ),
      );
    },
    [createAndSendOffer],
  );

  const refreshMicrophoneDevices = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      microphoneDevicesRef.current = [];
      audioOutputDevicesRef.current = [];
      setMicrophoneDevices([]);
      setAudioOutputDevices([]);
      setIsAudioOutputSelectionSupported(false);
      return;
    }

    setIsAudioOutputSelectionSupported(canSelectAudioOutputDevice());
    const devices = await navigator.mediaDevices
      .enumerateDevices()
      .catch(() => []);
    const audioInputDevices = devices.filter(
      (device) => device.kind === "audioinput",
    );
    const outputDevices = devices.filter((device) => device.kind === "audiooutput");
    microphoneDevicesRef.current = audioInputDevices;
    audioOutputDevicesRef.current = outputDevices;
    setMicrophoneDevices(audioInputDevices);
    setAudioOutputDevices(outputDevices);
  }, []);

  const stopLocalSubtitleCapture = useCallback(() => {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    setLocalPartialCaption(null);
  }, []);

  const startLocalSubtitleCapture = useCallback(async () => {
    if (audioCaptureRef.current) {
      return true;
    }

    const stream = localStreamRef.current;

    if (!stream) {
      return false;
    }

    const capture = createAudioCapture({
      stream,
      metadata: {
        roomId,
        participantId: participantIdRef.current,
        spokenLanguage: languageRef.current,
      },
      onSegment: (metadata, segment) => {
        socket.emit("audio:segment", {
          ...metadata,
          audio: segment.audio,
          isFinal: segment.isFinal,
          clientSegmentId: segment.clientSegmentId,
        });
      },
    });
    audioCaptureRef.current = capture;
    try {
      await capture.start();
      return audioCaptureRef.current === capture;
    } catch {
      if (audioCaptureRef.current === capture) audioCaptureRef.current = null;
      capture.stop();
      return false;
    }
  }, [roomId, socket]);

  const beginLocalSubtitleCapture = useCallback(async () => {
    const started = await startLocalSubtitleCapture();

    if (!started) {
      setError(t(languageRef.current, "subtitleServiceUnavailable"));
    }

    return started;
  }, [startLocalSubtitleCapture]);

  const createProcessedMicrophoneStream = useCallback(async () => {
    const deviceId = selectedMicrophoneDeviceIdRef.current;
    const savedDeviceIsListed =
      !deviceId ||
      microphoneDevicesRef.current.length === 0 ||
      microphoneDevicesRef.current.some((device) => device.deviceId === deviceId);
    const requestedDeviceId = savedDeviceIsListed ? deviceId : "";
    const deviceLabel = getMicrophoneDeviceLabel(
      microphoneDevicesRef.current,
      requestedDeviceId,
    );
    let rawStream: MediaStream;

    setMediaPreparationStep(
      !deviceId || requestedDeviceId ? "microphone" : "microphoneFallback",
    );

    try {
      rawStream = await getUserMediaWithTimeout({
        audio: microphoneConstraints(
          requestedDeviceId,
          deviceLabel,
          voiceSettingsRef.current.microphoneChannelMode,
        ),
        video: false,
      });
    } catch (mediaError) {
      if (!requestedDeviceId || isPermissionDeniedMediaError(mediaError)) {
        throw mediaError;
      }

      setMediaPreparationStep("microphoneFallback");
      selectedMicrophoneDeviceIdRef.current = "";
      setSelectedMicrophoneDeviceId("");
      saveMicrophoneDeviceId("");
      rawStream = await getUserMediaWithTimeout({
        audio: microphoneConstraints(
          "",
          "",
          voiceSettingsRef.current.microphoneChannelMode,
        ),
        video: false,
      });
    }

    if (deviceId && !requestedDeviceId) {
      selectedMicrophoneDeviceIdRef.current = "";
      setSelectedMicrophoneDeviceId("");
      saveMicrophoneDeviceId("");
    }

    const rawTrackLabel = rawStream.getAudioTracks()[0]?.label ?? deviceLabel;

    await refreshMicrophoneDevices();

    for (const track of rawStream.getAudioTracks()) {
      applyMicrophoneTrackConstraints(
        track,
        rawTrackLabel,
        voiceSettingsRef.current.microphoneChannelMode,
      );
    }

    setMediaPreparationStep("voice");
    const enhancedMicrophone = await createEnhancedMicrophoneStream(
      rawStream,
      localInputVolumeRef.current,
      voiceSettingsRef.current,
    );

    return {
      enhancedMicrophone,
      rawStream,
    };
  }, [refreshMicrophoneDevices]);

  const replaceLocalMicrophoneStream = useCallback(async () => {
    const localStream = localStreamRef.current;

    if (!localStream || !hasLiveAudioTrack(localStream)) {
      return false;
    }

    const wasCapturingSubtitles = Boolean(audioCaptureRef.current);
    const previousStop = audioEnhancementStopRef.current;
    const previousAudioTracks = localStream.getAudioTracks();

    if (wasCapturingSubtitles) {
      stopLocalSubtitleCapture();
    }

    let enhancedMicrophone: Awaited<
      ReturnType<typeof createProcessedMicrophoneStream>
    >["enhancedMicrophone"];
    let rawStream: MediaStream | null = null;

    try {
      const createdMicrophone = await createProcessedMicrophoneStream();
      enhancedMicrophone = createdMicrophone.enhancedMicrophone;
      rawStream = createdMicrophone.rawStream;
    } catch (mediaError) {
      if (wasCapturingSubtitles) {
        await beginLocalSubtitleCapture();
      }

      setError(
        mediaError instanceof DOMException && mediaError.name === "NotAllowedError"
          ? t(languageRef.current, "microphonePermissionDenied")
          : t(languageRef.current, "microphoneUnavailable"),
      );
      return false;
    }

    const [nextTrack] = enhancedMicrophone.stream.getAudioTracks();

    if (!nextTrack) {
      enhancedMicrophone.stop();
      rawStream?.getTracks().forEach((track) => track.stop());

      if (wasCapturingSubtitles) {
        await beginLocalSubtitleCapture();
      }

      setError(t(languageRef.current, "microphoneUnavailable"));
      return false;
    }

    nextTrack.enabled = !isMutedRef.current;

    for (const track of previousAudioTracks) {
      localStream.removeTrack(track);
    }

    localStream.addTrack(nextTrack);

    let needsNegotiation = false;
    await Promise.all(
      [...peerConnectionsRef.current.values()].map(async (peerState) => {
        const audioSender = peerState.peerConnection
          .getSenders()
          .find((sender) => sender.track?.kind === "audio");

        if (audioSender) {
          await audioSender.replaceTrack(nextTrack).catch(() => undefined);
          return;
        }

        peerState.peerConnection.addTrack(nextTrack, localStream);
        needsNegotiation = true;
      }),
    );

    audioEnhancementStopRef.current = enhancedMicrophone.stop;
    audioInputGainRef.current = enhancedMicrophone.setGain;
    audioInputProcessingRef.current = enhancedMicrophone.setProcessing;
    audioLevelUnsubscribeRef.current?.();
    audioLevelUnsubscribeRef.current =
      enhancedMicrophone.subscribeLevels(setMicrophoneLevel);
    rawMicrophoneStreamRef.current = rawStream;
    previousStop?.();
    stopLocalSpeakingMonitor();
    startLocalSpeakingMonitor(localStream);

    if (wasCapturingSubtitles) {
      await startLocalSubtitleCapture();
    }

    if (needsNegotiation && callState !== "idle") {
      await createOffersForAllPeers();
    }

    return true;
  }, [
    beginLocalSubtitleCapture,
    callState,
    createOffersForAllPeers,
    createProcessedMicrophoneStream,
    startLocalSpeakingMonitor,
    startLocalSubtitleCapture,
    stopLocalSpeakingMonitor,
    stopLocalSubtitleCapture,
  ]);

  const stopLocalMediaTracks = useCallback((stream: MediaStream | null) => {
    for (const track of selfMonitorStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }

    selfMonitorStreamRef.current = null;

    if (selfMonitorAudioRef.current) {
      selfMonitorAudioRef.current.pause();
      selfMonitorAudioRef.current.srcObject = null;
    }

    micTestRestoreRef.current = null;
    setIsTestingMicrophone(false);

    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }

    audioEnhancementStopRef.current?.();
    audioLevelUnsubscribeRef.current?.();
    audioEnhancementStopRef.current = null;
    audioInputGainRef.current = null;
    audioInputProcessingRef.current = null;
    audioLevelUnsubscribeRef.current = null;
    rawMicrophoneStreamRef.current = null;
    setMicrophoneLevel(idleMicrophoneLevelSnapshot);
  }, []);

  const resetLocalMediaState = useCallback(() => {
    stopLocalSpeakingMonitor();
    stopLocalMediaTracks(localStreamRef.current);
    stopLocalMediaTracks(localScreenStreamRef.current);
    localStreamRef.current = null;
    localScreenStreamRef.current = null;
    setIsMediaReady(false);
    setIsCameraEnabled(false);
    setIsScreenSharing(false);
    isDeafenedRef.current = false;
    deafenRestoreMutedRef.current = null;
    setIsDeafened(false);
    setActiveScreenShareQuality(null);
    setIsApplyingScreenQuality(false);
    setScreenShareStats(null);
    setShowScreenShareSettings(false);
    setActiveScreenShareParticipantId((current) =>
      current === participantIdRef.current ? "" : current,
    );

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  }, [stopLocalMediaTracks, stopLocalSpeakingMonitor]);

  const resetRemoteMediaState = useCallback(() => {
    for (const participantId of remoteSpeakingMonitorsRef.current.keys()) {
      stopRemoteSpeakingMonitor(participantId);
    }

    setRemoteParticipants({});
    remoteTrackStreamIdsRef.current.clear();
    remoteScreenStreamIdsRef.current.clear();
  }, [stopRemoteSpeakingMonitor]);

  const tearDownActiveCall = useCallback((updateCallState = true) => {
    hasEndedCallRef.current = true;

    if (roomEndRedirectTimeoutRef.current !== null) {
      window.clearTimeout(roomEndRedirectTimeoutRef.current);
      roomEndRedirectTimeoutRef.current = null;
    }

    stopLocalSubtitleCapture();
    resetRemoteMediaState();
    resetLocalMediaState();
    closeAllPeerConnections();
    fileTransfersRef.current.clear();
    setAttachmentDraft(null);
    setDominantSurface(null);
    setFullscreenSurface(null);
    if (updateCallState) setCallState("disconnected");
  }, [
    closeAllPeerConnections,
    resetLocalMediaState,
    resetRemoteMediaState,
    stopLocalSubtitleCapture,
  ]);

  const rememberParticipantSessionToken = useCallback(
    (token: string) => {
      participantSessionTokenRef.current = token;
      saveParticipantSessionTokenForRoom(roomId, token);
    },
    [roomId],
  );

  useEffect(() => {
    const savedLanguage = getSavedLanguage();
    const savedLocalInputVolume = getSavedVolume(
      localInputVolumeStorageKey,
      defaultLocalInputVolume,
    );
    const savedMasterOutputVolume = getSavedVolume(
      masterOutputVolumeStorageKey,
      defaultMasterOutputVolume,
    );
    const savedScreenShareAudioVolume = getSavedVolume(
      screenShareAudioVolumeStorageKey,
      defaultScreenShareAudioVolume,
    );
    const savedAudioOutputDeviceId = getSavedAudioOutputDeviceId();
    setLanguage(savedLanguage);
    setMediaLayoutMode(getSavedMediaLayoutMode());
    setFullscreenConversationMode("visible");
    setConversationDisplayMode("panel");
    saveFullscreenConversationMode("visible");
    localInputVolumeRef.current = savedLocalInputVolume;
    masterOutputVolumeRef.current = savedMasterOutputVolume;
    screenShareAudioVolumeRef.current = savedScreenShareAudioVolume;
    selectedAudioOutputDeviceIdRef.current = savedAudioOutputDeviceId;
    setLocalInputVolume(savedLocalInputVolume);
    setMasterOutputVolume(savedMasterOutputVolume);
    setScreenShareAudioVolume(savedScreenShareAudioVolume);
    setSelectedAudioOutputDeviceId(savedAudioOutputDeviceId);
    setRemoteVolumes(getSavedRemoteVolumes());

    if (savedLanguage) {
      languageRef.current = savedLanguage;
    }

    const savedDisplayName = getSavedDisplayName();
    setDisplayName(savedDisplayName);
    displayNameRef.current = savedDisplayName;

    participantIdRef.current = getSessionParticipantId();
    const savedRoomCode = getSavedRoomCodeForRoom(roomId);
    setRoomCode(savedRoomCode);
    roomCodeRef.current = savedRoomCode;
    participantSessionTokenRef.current =
      getSavedParticipantSessionTokenForRoom(roomId);
  }, [roomId]);

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!language) {
      return;
    }

    languageRef.current = language;
    audioCaptureRef.current?.updateMetadata({
      roomId,
      participantId: participantIdRef.current,
      spokenLanguage: language,
    });

    if (callState !== "idle" && socket.connected) {
      socket.emit("participant:language", {
        roomId,
        participantId: participantIdRef.current,
        spokenLanguage: language,
      });
    }
  }, [callState, language, roomId, socket]);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    if (!language) {
      return;
    }

    const currentLanguage = language;
    let isCancelled = false;

    async function loadRoom() {
      try {
        const response = await fetch(`/api/rooms/${roomId}`, {
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error("room-not-found");
        }

        const info = (await response.json()) as RoomInfo;

        if (!isCancelled) {
          setRoomInfo(info);
          setIsSubtitleServiceStarted(info.subtitleServiceStarted);
          setActiveScreenShareParticipantId(info.activeScreenShareParticipantId ?? "");
        }
      } catch {
        if (!isCancelled) {
          setError(t(currentLanguage, "roomNotFound"));
        }
      }
    }

    void loadRoom();

    return () => {
      isCancelled = true;
    };
  }, [language, roomId]);

  useEffect(() => {
    setIsScreenShareSupported(Boolean(navigator.mediaDevices?.getDisplayMedia));
  }, []);

  useEffect(() => {
    void refreshMicrophoneDevices();

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.addEventListener
    ) {
      return;
    }

    const handleDeviceChange = () => {
      void refreshMicrophoneDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [refreshMicrophoneDevices]);

  useDialogFocus(showSettings || showVoiceSettings || showLayoutPicker || showLeaveConfirmation || showScreenShareSettings || Boolean(surfacePickerTarget));

  useEffect(() => {
    if (
      !showSettings &&
      !showVoiceSettings &&
      !showLayoutPicker &&
      !showLeaveConfirmation &&
      !showScreenShareSettings &&
      !surfacePickerTarget
    ) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        stopMicrophoneTestRef.current();
        setShowSettings(false);
        setShowVoiceSettings(false);
        setShowLayoutPicker(false);
        setShowLeaveConfirmation(false);
        setShowScreenShareSettings(false);
        setSurfacePickerTarget(null);
        setScreenShareQuality((current) => activeScreenShareQuality ?? current);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("garden-modal-open");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("garden-modal-open");
    };
  }, [
    activeScreenShareQuality,
    showLayoutPicker,
    showLeaveConfirmation,
    showScreenShareSettings,
    showSettings,
    showVoiceSettings,
    surfacePickerTarget,
  ]);

  useEffect(() => {
    if (!showVolumeMixer) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (
        volumeMixerRef.current?.contains(target) ||
        volumeButtonRef.current?.contains(target) ||
        fullscreenVolumeButtonRef.current?.contains(target)
      ) {
        return;
      }

      setShowVolumeMixer(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowVolumeMixer(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showVolumeMixer]);

  useEffect(() => {
    if (!showConversationModeMenu) {
      setConversationModeMenuPosition(null);
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      const menuRoots = document.querySelectorAll(
        "[data-conversation-mode-menu-root]",
      );

      for (const root of menuRoots) {
        if (root.contains(target)) {
          return;
        }
      }

      setShowConversationModeMenu(false);
      setConversationModeMenuPosition(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowConversationModeMenu(false);
        setConversationModeMenuPosition(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showConversationModeMenu]);

  useEffect(() => {
    if (!isScreenSharing || !activeScreenShareQuality || isApplyingScreenQuality) {
      setScreenShareStats(null);
      return;
    }

    let isActive = true;
    let polling = false;
    const samples = new Map<RTCRtpSender, ScreenEncodingSample>();
    const adaptations = new Map<RTCRtpSender, ReturnType<typeof initialScreenAdaptation>>();
    const failedSenders = new Set<RTCRtpSender>();
    const settings = activeScreenShareQuality;

    async function updateScreenShareStats() {
      if (polling) return;
      polling = true;
      try {
        const screenTrack = localScreenStreamRef.current?.getVideoTracks()[0];
        if (!screenTrack || screenTrack.readyState !== "live") return;
        const snapshots = await Promise.allSettled([...peerConnectionsRef.current.entries()].map(async ([participantId, peerState]) => {
          const sender = findSenderForTrack(peerState.peerConnection, screenTrack);
          if (!sender) return null;
          const [senderStats, connectionStats] = await Promise.all([
            sender.getStats().catch(() => null),
            peerState.peerConnection.getStats().catch(() => null),
          ]);
          if (!isActive || sender.track !== screenTrack || !senderStats || !connectionStats) return null;
          let outbound: RTCStats | undefined;
          senderStats.forEach(report => {
            if (report.type === "outbound-rtp" &&
              (reportString(report, "kind") === "video" || reportString(report, "mediaType") === "video")) outbound = report;
          });
          if (!outbound) return null;
          const path = getSelectedConnectionPath(connectionStats);
          const sample: ScreenEncodingSample = {
            id: outbound.id,
            timestamp: outbound.timestamp,
            bytesSent: reportNumber(outbound, "bytesSent"),
            framesEncoded: reportNumber(outbound, "framesEncoded"),
            totalEncodeTime: reportNumber(outbound, "totalEncodeTime"),
            rttMeasurements: path.roundTripMeasurements,
          };
          const previous = samples.get(sender);
          const rates = screenEncodingRates(sample, previous);
          samples.set(sender, sample);
          const limitation = reportString(outbound, "qualityLimitationReason");
          const state = adaptations.get(sender) ?? initialScreenAdaptation();
          const freshRttMs = previous && sample.rttMeasurements !== undefined &&
            previous.rttMeasurements !== undefined && sample.rttMeasurements > previous.rttMeasurements
              ? path.roundTripMs : undefined;
          const next = adaptScreenStream(state, {
            now: performance.now(), active: (rates.fps ?? 0) > 0, limitation, freshRttMs,
          });
          if (next.level !== state.level && !failedSenders.has(sender)) {
            const applied = await tuneSenderEncoding(sender, {
              ...screenAdaptationParameters(settings, next.level),
              degradationPreference: settings.optimization === "detail" ? "maintain-resolution" : "balanced",
            });
            if (!isActive) return null;
            if (applied) adaptations.set(sender, next);
            else {
              failedSenders.add(sender);
              setMediaNotice(t(languageRef.current, "screenQualitySettingsFailed"));
            }
          } else adaptations.set(sender, { ...next, level: state.level });
          const codec = connectionStats.get(reportString(outbound, "codecId") ?? "");
          const powerEfficient = (outbound as unknown as Record<string, unknown>).powerEfficientEncoder;
          const bitrateLimit = sender.getParameters().encodings?.[0]?.maxBitrate;
          return {
            ...rates,
            fps: reportNumber(outbound, "framesPerSecond") ?? rates.fps,
            height: reportNumber(outbound, "frameHeight"),
            width: reportNumber(outbound, "frameWidth"),
            path: path.path,
            roundTripMs: path.roundTripMs,
            limitation,
            recipient: remoteParticipantsRef.current[participantId]?.displayName,
            codec: codec ? reportString(codec, "mimeType")?.replace(/^video\//, "") : undefined,
            encoder: reportString(outbound, "encoderImplementation"),
            powerEfficient: typeof powerEfficient === "boolean" ? powerEfficient : undefined,
            bitrateLimitKbps: bitrateLimit !== undefined ? Math.round(bitrateLimit / 1000) : undefined,
          } satisfies ScreenShareStatsSnapshot;
        }));
        if (!isActive) return;
        const available = snapshots.flatMap(result => {
          if (result.status === "fulfilled") return result.value ? [result.value] : [];
          console.warn("Screen-share peer statistics unavailable", result.reason instanceof Error ? result.reason.name : "UnknownError");
          return [];
        });
        // Label the recipient explicitly rather than mixing statistics from peers.
        available.sort((a, b) => (b.roundTripMs ?? 0) - (a.roundTripMs ?? 0));
        setScreenShareStats(available[0] ?? null);
        const liveSenders = new Set([...peerConnectionsRef.current.values()].flatMap(peer => peer.peerConnection.getSenders()));
        for (const sender of samples.keys()) {
          if (!liveSenders.has(sender)) {
            samples.delete(sender); adaptations.delete(sender); failedSenders.delete(sender);
          }
        }
      } catch (error) {
        console.warn("Screen-share statistics unavailable", error instanceof Error ? error.name : "UnknownError");
      } finally { polling = false; }
    }

    void updateScreenShareStats();
    const interval = window.setInterval(() => { void updateScreenShareStats(); }, 2000);
    return () => { isActive = false; window.clearInterval(interval); };
  }, [isScreenSharing, activeScreenShareQuality, isApplyingScreenQuality]);

  useEffect(() => {
    if (callState === "idle" || remoteList.length === 0) {
      setConnectionPathSnapshots({});
      return;
    }

    let isActive = true;

    async function updateConnectionPathSnapshots() {
      const participants = Object.values(remoteParticipantsRef.current).sort(
        (first, second) => first.joinedAt - second.joinedAt,
      );
      const updatedAt = Date.now();
      const entries = await Promise.all(
        participants.map(async (participant) => {
          const peerState = peerConnectionsRef.current.get(
            participant.participantId,
          );
          const selectedPath = peerState
            ? await peerState.peerConnection
                .getStats()
                .then(getSelectedConnectionPath)
                .catch(() => ({
                  path: "unknown" as const,
                  roundTripMs: undefined,
                }))
            : { path: "unknown" as const, roundTripMs: undefined };

          return [
            participant.participantId,
            {
              displayName: participant.displayName,
              participantId: participant.participantId,
              path: selectedPath.path,
              roundTripMs: selectedPath.roundTripMs,
              updatedAt,
            },
          ] as const;
        }),
      );

      if (!isActive) {
        return;
      }

      setConnectionPathSnapshots(Object.fromEntries(entries));
    }

    void updateConnectionPathSnapshots();
    const interval = window.setInterval(() => {
      void updateConnectionPathSnapshots();
    }, 2000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [callState, remoteList.length]);

  useEffect(() => {
    if (!showSubtitleNotice) {
      return;
    }

    const timeout = window.setTimeout(() => setShowSubtitleNotice(false), 3600);
    return () => window.clearTimeout(timeout);
  }, [showSubtitleNotice, subtitleNoticeId]);

  const loadTurnStatus = useCallback(async () => {
    const response = await fetch("/api/turn/status", {
      cache: "no-store",
      credentials: "include",
    });

    if (!response.ok) {
      return null;
    }

    const nextStatus = (await response.json()) as TurnStatus;
    setTurnStatus(nextStatus);
    return nextStatus;
  }, []);

  useEffect(() => {
    if (!roomInfo?.isCreator && !isRoomHost) {
      setTurnStatus(null);
      return;
    }

    void loadTurnStatus().catch(() => undefined);
  }, [
    isRoomHost,
    loadTurnStatus,
    roomInfo?.isCreator,
  ]);

  useEffect(() => {
    function handlePeerJoined(payload: PublicParticipant) {
      if (hasEndedCallRef.current) {
        return;
      }

      upsertRemoteParticipant(payload);
      ensurePeerConnection(payload.participantId);
      setCallState("connecting");

      if (hasLiveVideoTrack(localStreamRef.current)) {
        socket.emit("media:camera-started", {
          roomId,
          from: participantIdRef.current,
        });
      }

      if (localScreenStreamRef.current) {
        socket.emit("media:screen-started", {
          roomId,
          from: participantIdRef.current,
          streamId: localScreenStreamRef.current.id,
        });
      }
    }

    async function handleOffer(payload: {
      description: RTCSessionDescriptionInit;
      from: string;
      iceRestart?: boolean;
    }) {
      if (hasEndedCallRef.current || !payload.from) {
        return;
      }

      const peerState = ensurePeerConnection(payload.from);
      const offerCollision =
        payload.description.type === "offer" &&
        (peerState.makingOffer ||
          peerState.peerConnection.signalingState !== "stable");
      peerState.ignoreOffer = !peerState.polite && offerCollision;

      if (peerState.ignoreOffer) {
        return;
      }

      if (
        payload.iceRestart === true ||
        isRelayOnlyPeerConnection(peerState.peerConnection)
      ) {
        await enableTurnFallbackIceServers(peerState).catch(() => false);
      }

      await peerState.peerConnection.setRemoteDescription(payload.description);
      await flushPendingIceCandidates(peerState);

      if (payload.description.type === "offer") {
        if (!preferScreenH264(peerState.peerConnection, localScreenStreamRef.current?.getVideoTracks()[0])) {
          setMediaNotice(t(languageRef.current, "screenQualitySettingsFailed"));
        }
        const answer = await peerState.peerConnection.createAnswer();
        await peerState.peerConnection.setLocalDescription(
          configureCallAudioDescription(
            answer,
            localScreenStreamRef.current?.id,
            peerState.peerConnection.remoteDescription,
          ),
        );
        socket.emit("webrtc:answer", {
          roomId,
          toParticipantId: payload.from,
          description: peerState.peerConnection.localDescription,
        });
      }
    }

    async function handleAnswer(payload: {
      description: RTCSessionDescriptionInit;
      from: string;
    }) {
      if (hasEndedCallRef.current || !payload.from) {
        return;
      }

      const peerState = peerConnectionsRef.current.get(payload.from);

      if (!peerState || peerState.peerConnection.signalingState === "stable") {
        return;
      }

      await peerState.peerConnection
        .setRemoteDescription(payload.description)
        .catch(() => undefined);
      await flushPendingIceCandidates(peerState);
    }

    async function handleIceCandidate(payload: {
      candidate: RTCIceCandidateInit;
      from: string;
    }) {
      if (hasEndedCallRef.current || !payload.from) {
        return;
      }

      const peerState = ensurePeerConnection(payload.from);

      if (!peerState.peerConnection.remoteDescription) {
        peerState.pendingIceCandidates.push(payload.candidate);
        return;
      }

      await peerState.peerConnection
        .addIceCandidate(payload.candidate)
        .catch(() => undefined);
    }

    function handleRemoteScreenStarted(payload: {
      from?: string;
      streamId?: string;
    }) {
      const participantId = payload.from ?? "";
      const streamId = payload.streamId ?? "";

      if (!participantId || !streamId) {
        return;
      }

      remoteScreenStreamIdsRef.current.set(participantId, streamId);
      setActiveScreenShareParticipantId(participantId);
      updateRemoteParticipant(participantId, (participant) => {
        const trackStreamIds =
          remoteTrackStreamIdsRef.current.get(participantId) ?? new Map();

        for (const track of participant.cameraStream.getVideoTracks()) {
          if (trackStreamIds.get(track.id) === streamId) {
            participant.cameraStream.removeTrack(track);
            participant.screenStream.addTrack(track);
          }
        }

        for (const track of participant.audioStream.getAudioTracks()) {
          if (trackStreamIds.get(track.id) === streamId) {
            participant.audioStream.removeTrack(track);
            participant.screenAudioStream.addTrack(track);
          }
        }

        return {
          ...participant,
          hasScreenShare: true,
          hasVideo: participant.cameraStream
            .getVideoTracks()
            .some((track) => track.readyState === "live"),
          screenStreamId: streamId,
        };
      });
      window.setTimeout(() => {
        const participant = remoteParticipantsRef.current[participantId];

        if (
          participant?.audioStream
            .getAudioTracks()
            .some((track) => track.readyState === "live")
        ) {
          startRemoteSpeakingMonitor(participantId, participant.audioStream);
        } else {
          stopRemoteSpeakingMonitor(participantId);
        }

        playRemoteAudio();
      }, 0);
    }

    function handleRemoteScreenStopped(payload: { from?: string }) {
      const participantId = payload.from ?? "";

      if (!participantId) {
        return;
      }

      remoteScreenStreamIdsRef.current.delete(participantId);
      setActiveScreenShareParticipantId((current) =>
        current === participantId ? "" : current,
      );
      updateRemoteParticipant(participantId, (participant) => {
        for (const track of participant.screenStream.getTracks()) {
          participant.screenStream.removeTrack(track);
        }

        for (const track of participant.screenAudioStream.getTracks()) {
          participant.screenAudioStream.removeTrack(track);
        }

        return {
          ...participant,
          hasScreenShare: false,
          screenStreamId: "",
        };
      });
      window.setTimeout(playRemoteAudio, 0);
    }

    function handleRemoteCameraStarted(payload: { from?: string }) {
      if (!payload.from) {
        return;
      }

      updateRemoteParticipant(payload.from, (participant) => ({
        ...participant,
        hasVideo: participant.cameraStream
          .getVideoTracks()
          .some((track) => track.readyState === "live"),
      }));
    }

    function handleRemoteCameraStopped(payload: { from?: string }) {
      if (!payload.from) {
        return;
      }

      updateRemoteParticipant(payload.from, (participant) => {
        for (const track of participant.cameraStream.getVideoTracks()) {
          participant.cameraStream.removeTrack(track);
        }

        return {
          ...participant,
          hasVideo: false,
        };
      });
    }

    function handleChatMessage(message: ChatMessage) {
      if (message.roomId === roomId) setChatMessages(log => upsertChatMessage(log, message));
    }

    function handleCaption(caption: CaptionEvent) {
      setRemoteCaptionLog((log) =>
        caption.isFinal ? appendCaptionLog(log, caption) : log,
      );
    }

    function handleCaptionPreview(caption: CaptionEvent) {
      if (caption.isFinal) {
        setLocalPartialCaption(null);
        setLocalCaptionLog((log) => appendCaptionLog(log, caption));
      } else {
        setLocalPartialCaption(caption);
      }
    }

    function handleCaptionError() {
      setError(t(languageRef.current, "subtitleServiceUnavailable"));
    }

    async function handleSubtitleServiceStarted() {
      setIsSubtitleServiceStarted(true);
      showSubtitleServiceBanner("subtitleServiceStartedNotice");
      await beginLocalSubtitleCapture();
    }

    function handleSubtitleServiceStopped() {
      setIsSubtitleServiceStarted(false);
      showSubtitleServiceBanner("subtitleServiceStoppedNotice");
      stopLocalSubtitleCapture();
    }

    function handlePeerLeft(payload: { participantId?: string }) {
      const participantId = payload.participantId ?? "";

      if (!participantId) {
        return;
      }

      removeRemotePeer(participantId);
      setCallState(remoteList.length <= 1 ? "waiting" : "connected");
    }

    function handleRoomEnded(payload?: { endedBy?: string }) {
      tearDownActiveCall();

      if (payload?.endedBy === participantIdRef.current) {
        router.push("/");
        return;
      }

      showSubtitleServiceBanner("callHostLeftNotice");
      roomEndRedirectTimeoutRef.current = window.setTimeout(() => {
        roomEndRedirectTimeoutRef.current = null;
        router.push("/");
      }, 5000);
    }

    function handleScreenRejected() {
      setMediaNotice(t(languageRef.current, "screenShareAlreadyActive"));
      void stopScreenShareRef.current({ emit: false, renegotiate: true });
    }

    function handleReconnectAttempt() {
      if (!hasEndedCallRef.current) {
        setCallState("reconnecting");
      }
    }

    function handleReconnectFailed() {
      if (hasEndedCallRef.current) {
        return;
      }

      tearDownActiveCall();
      setError(t(languageRef.current, "disconnected"));
    }

    function handleSocketDisconnect(reason: string) {
      if (hasEndedCallRef.current || reason === "io client disconnect") {
        return;
      }

      if (reason === "io server disconnect") {
        tearDownActiveCall();
        setError(t(languageRef.current, "disconnected"));
        return;
      }

      if (callState !== "idle" && callState !== "disconnected") {
        setCallState("reconnecting");
      }
    }

    async function handleReconnect() {
      if (
        hasEndedCallRef.current ||
        !languageRef.current ||
        callState === "idle" ||
        callState === "disconnected"
      ) {
        return;
      }

      socket.emit(
        "room:join",
        {
          roomId,
          roomCode: roomCodeRef.current,
          participantId: participantIdRef.current,
          participantSessionToken: participantSessionTokenRef.current,
          displayName: displayNameRef.current,
          spokenLanguage: languageRef.current,
        },
        async (response: JoinResponse) => {
          if (!response.ok) {
            setError(errorForJoinReason(languageRef.current, response.reason));
            return;
          }

          rememberParticipantSessionToken(response.participantSessionToken);
          setIsRoomHost(response.isCreator);
          setIsSubtitleServiceStarted(response.subtitleServiceStarted);
          setActiveScreenShareParticipantId(
            response.activeScreenShareParticipantId ?? "",
          );
          const connectedParticipantIds = new Set(
            response.otherParticipants.map((participant) => participant.participantId),
          );
          for (const participantId of Object.keys(remoteParticipantsRef.current)) {
            if (!connectedParticipantIds.has(participantId)) {
              removeRemotePeer(participantId);
            }
          }
          for (const participant of response.otherParticipants) {
            upsertRemoteParticipant(participant);
            ensurePeerConnection(participant.participantId);
          }
          if (response.subtitleServiceStarted) {
            await beginLocalSubtitleCapture();
          }
        },
      );
    }

    function handleServerShutdown() {
      if (!hasEndedCallRef.current) {
        tearDownActiveCall();
        setError(t(languageRef.current, "disconnected"));
      }

      socket.disconnect();
    }

    socket.on("peer:joined", handlePeerJoined);
    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    socket.on("media:screen-started", handleRemoteScreenStarted);
    socket.on("media:screen-stopped", handleRemoteScreenStopped);
    socket.on("media:screen-rejected", handleScreenRejected);
    socket.on("media:camera-started", handleRemoteCameraStarted);
    socket.on("media:camera-stopped", handleRemoteCameraStopped);
    socket.on("chat:message", handleChatMessage);
    socket.on("caption", handleCaption);
    socket.on("caption:preview", handleCaptionPreview);
    socket.on("caption:error", handleCaptionError);
    socket.on("subtitle:service-started", handleSubtitleServiceStarted);
    socket.on("subtitle:service-stopped", handleSubtitleServiceStopped);
    socket.on("peer:left", handlePeerLeft);
    socket.on("room:ended", handleRoomEnded);
    socket.on("server:shutdown", handleServerShutdown);
    socket.on("disconnect", handleSocketDisconnect);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);
    socket.io.on("reconnect_failed", handleReconnectFailed);

    return () => {
      socket.off("peer:joined", handlePeerJoined);
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:answer", handleAnswer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
      socket.off("media:screen-started", handleRemoteScreenStarted);
      socket.off("media:screen-stopped", handleRemoteScreenStopped);
      socket.off("media:screen-rejected", handleScreenRejected);
      socket.off("media:camera-started", handleRemoteCameraStarted);
      socket.off("media:camera-stopped", handleRemoteCameraStopped);
      socket.off("chat:message", handleChatMessage);
      socket.off("caption", handleCaption);
      socket.off("caption:preview", handleCaptionPreview);
      socket.off("caption:error", handleCaptionError);
      socket.off("subtitle:service-started", handleSubtitleServiceStarted);
      socket.off("subtitle:service-stopped", handleSubtitleServiceStopped);
      socket.off("peer:left", handlePeerLeft);
      socket.off("room:ended", handleRoomEnded);
      socket.off("server:shutdown", handleServerShutdown);
      socket.off("disconnect", handleSocketDisconnect);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
      socket.io.off("reconnect_failed", handleReconnectFailed);
    };
  }, [
    beginLocalSubtitleCapture,
    callState,
    enableTurnFallbackIceServers,
    ensurePeerConnection,
    flushPendingIceCandidates,
    playRemoteAudio,
    rememberParticipantSessionToken,
    removeRemotePeer,
    remoteList.length,
    roomId,
    router,
    showSubtitleServiceBanner,
    socket,
    stopLocalSubtitleCapture,
    stopRemoteSpeakingMonitor,
    startRemoteSpeakingMonitor,
    tearDownActiveCall,
    updateRemoteParticipant,
    upsertRemoteParticipant,
  ]);

  useEffect(() => {
    return () => {
      const shouldNotifyLeave = socket.connected && !hasEndedCallRef.current;
      const participantId = participantIdRef.current;

      // Unmount cleanup also runs during the development Strict Mode check.
      tearDownActiveCall(false);

      if (shouldNotifyLeave) {
        socket.emit("room:leave", {
          roomId,
          participantId,
        });
      }
    };
  }, [roomId, socket, tearDownActiveCall]);

  const requestCameraTrack = useCallback(async () => {
    const videoStream = await getUserMediaWithTimeout({
      audio: false,
      video: {
        aspectRatio: 16 / 9,
        facingMode: "user",
        height: { ideal: 720 },
        width: { ideal: 1280 },
      },
    });
    const [track] = videoStream.getVideoTracks();

    if (!track) {
      throw new Error("camera-unavailable");
    }

    return track;
  }, []);

  const requestMedia = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      throw new Error("browser-unsupported");
    }

    resetLocalMediaState();

    let enhancedMicrophone: Awaited<
      ReturnType<typeof createProcessedMicrophoneStream>
    >["enhancedMicrophone"];
    let rawMicrophoneStream: MediaStream;

    try {
      const createdMicrophone = await createProcessedMicrophoneStream();
      enhancedMicrophone = createdMicrophone.enhancedMicrophone;
      rawMicrophoneStream = createdMicrophone.rawStream;
    } catch (mediaError) {
      throw new Error(
        isPermissionDeniedMediaError(mediaError)
          ? "microphone-denied"
          : "microphone-unavailable",
      );
    }

    audioEnhancementStopRef.current = enhancedMicrophone.stop;
    audioInputGainRef.current = enhancedMicrophone.setGain;
    audioInputProcessingRef.current = enhancedMicrophone.setProcessing;
    audioLevelUnsubscribeRef.current?.();
    audioLevelUnsubscribeRef.current =
      enhancedMicrophone.subscribeLevels(setMicrophoneLevel);
    rawMicrophoneStreamRef.current = rawMicrophoneStream;
    const combinedStream = new MediaStream(enhancedMicrophone.stream.getAudioTracks());

    for (const track of combinedStream.getAudioTracks()) {
      track.enabled = !isMuted;
    }

    if (startWithCameraOff) {
      setIsCameraEnabled(false);
      setMediaNotice("");
    } else {
      try {
        setMediaPreparationStep("camera");
        combinedStream.addTrack(await requestCameraTrack());
        setIsCameraEnabled(true);
        setMediaNotice("");
      } catch (mediaError) {
        setIsCameraEnabled(false);
        setMediaNotice(
          mediaError instanceof DOMException &&
            mediaError.name === "NotAllowedError"
            ? t(languageRef.current, "cameraPermissionDenied")
            : t(languageRef.current, "cameraUnavailable"),
        );
      }
    }

    localStreamRef.current = combinedStream;
    startLocalSpeakingMonitor(combinedStream);
    setIsMediaReady(true);
    attachLocalPreview();

    return combinedStream;
  }, [
    isMuted,
    attachLocalPreview,
    createProcessedMicrophoneStream,
    requestCameraTrack,
    resetLocalMediaState,
    startLocalSpeakingMonitor,
    startWithCameraOff,
  ]);

  async function handlePrepareMedia() {
    setError("");
    setMediaNotice("");
    setIsPreparingMedia(true);

    try {
      await requestMedia();
    } catch (mediaError) {
      const message = mediaError instanceof Error ? mediaError.message : "";

      if (message === "microphone-denied") {
        setError(t(languageRef.current, "microphonePermissionDenied"));
      } else if (message === "browser-unsupported") {
        setError(t(languageRef.current, "browserUnsupported"));
      } else {
        setError(t(languageRef.current, "microphoneUnavailable"));
      }
    } finally {
      setMediaPreparationStep("idle");
      setIsPreparingMedia(false);
    }
  }

  const connectSocketForRoomJoin = useCallback(
    async ({ refreshHandshake }: { refreshHandshake: boolean }) => {
      if (!refreshHandshake && socket.connected) {
        return;
      }

      if (refreshHandshake && socket.connected) {
        socket.disconnect();
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("socket-connect-timeout"));
        }, 8000);

        function cleanup() {
          window.clearTimeout(timeout);
          socket.off("connect", handleConnect);
          socket.off("connect_error", handleConnectError);
        }

        function handleConnect() {
          cleanup();
          resolve();
        }

        function handleConnectError(error: Error) {
          cleanup();
          reject(error);
        }

        socket.once("connect", handleConnect);
        socket.once("connect_error", handleConnectError);
        socket.connect();
      });
    },
    [socket],
  );

  const handleJoinCall = useCallback(
    async (preparedStream?: MediaStream) => {
      playRemoteAudio();

      if (!language || !roomInfo) {
        return;
      }

      stopMicrophoneTestRef.current();
      setError("");
      hasEndedCallRef.current = false;
      setCallState("connecting");

      let stream = preparedStream ?? localStreamRef.current;
      if (!hasLiveAudioTrack(stream)) {
        try {
          stream = await requestMedia();
        } catch (mediaError) {
          const message = mediaError instanceof Error ? mediaError.message : "";
          setCallState("idle");

          if (message === "microphone-denied") {
            setError(t(language, "microphonePermissionDenied"));
          } else if (message === "browser-unsupported") {
            setError(t(language, "browserUnsupported"));
          } else {
            setError(t(language, "microphoneUnavailable"));
          }

          return;
        }
      }

      try {
        await connectSocketForRoomJoin({
          refreshHandshake: roomInfo.isCreator,
        });
      } catch {
        setCallState("idle");
        setError(t(language, "disconnected"));
        resetLocalMediaState();
        return;
      }

      socket.emit(
        "room:join",
        {
          roomId,
          roomCode,
          participantId: participantIdRef.current,
          participantSessionToken: participantSessionTokenRef.current,
          displayName,
          spokenLanguage: language,
        },
        async (response: JoinResponse) => {
          if (!response.ok) {
            setCallState("idle");
            setError(errorForJoinReason(language, response.reason));
            resetLocalMediaState();
            return;
          }

          rememberParticipantSessionToken(response.participantSessionToken);
          setIsRoomHost(response.isCreator);
          setIsSubtitleServiceStarted(response.subtitleServiceStarted);
          setActiveScreenShareParticipantId(
            response.activeScreenShareParticipantId ?? "",
          );
          setRoomInfo((current) =>
            current
              ? {
                  ...current,
                  maxParticipants: response.maxParticipants,
                  participantCount: response.participantCount,
                }
              : current,
          );

          for (const participant of response.otherParticipants) {
            upsertRemoteParticipant(participant);
            ensurePeerConnection(participant.participantId);
          }

          setCallState(
            response.otherParticipants.length > 0 ? "connecting" : "waiting",
          );

          if (hasLiveVideoTrack(stream)) {
            socket.emit("media:camera-started", {
              roomId,
              from: participantIdRef.current,
            });
          }

          if (response.subtitleServiceStarted) {
            await beginLocalSubtitleCapture();
          }
        },
      );
    },
    [
      beginLocalSubtitleCapture,
      connectSocketForRoomJoin,
      displayName,
      ensurePeerConnection,
      language,
      playRemoteAudio,
      rememberParticipantSessionToken,
      requestMedia,
      resetLocalMediaState,
      roomCode,
      roomId,
      roomInfo,
      socket,
      upsertRemoteParticipant,
    ],
  );

  useEffect(() => {
    if (
      callState !== "idle" ||
      !isMediaReady ||
      isPreparingMedia ||
      !roomInfo ||
      !hasLiveAudioTrack(localStreamRef.current) ||
      showSettings ||
      showVoiceSettings ||
      showLayoutPicker ||
      showLeaveConfirmation ||
      showScreenShareSettings ||
      surfacePickerTarget
    ) {
      return;
    }

    function handlePreviewKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.repeat) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      void handleJoinCall();
    }

    document.addEventListener("keydown", handlePreviewKeyDown);

    return () => {
      document.removeEventListener("keydown", handlePreviewKeyDown);
    };
  }, [
    callState,
    handleJoinCall,
    isMediaReady,
    isPreparingMedia,
    roomInfo,
    showLayoutPicker,
    showLeaveConfirmation,
    showScreenShareSettings,
    showSettings,
    showVoiceSettings,
    surfacePickerTarget,
  ]);

  function handleLanguageSelect(nextLanguage: Language) {
    saveLanguage(nextLanguage);
    setLanguage(nextLanguage);
  }

  function handleUsernameSubmit(nextDisplayName: string) {
    saveDisplayName(nextDisplayName);
    setDisplayName(nextDisplayName);
  }

  function handleBackToLanguage() {
    clearSavedLanguage();
    setLanguage(null);
    setError("");
  }

  function handleBackToHome() {
    if (callState === "idle") {
      resetLocalMediaState();
      router.push("/");
      return;
    }

    requestLeaveConfirmation();
  }

  async function handleCopyCode() {
    if (!roomInfo?.roomCode) {
      return;
    }

    await navigator.clipboard.writeText(roomInfo.roomCode);
    setIsCodeCopied(true);
    window.setTimeout(() => setIsCodeCopied(false), 1600);
  }

  function setLocalMuteState(nextMuted: boolean) {
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }

    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
  }

  function handleToggleMute() {
    playRemoteAudio();

    if (isTestingMicrophone) {
      return;
    }

    if (isDeafenedRef.current && isMutedRef.current) {
      deafenRestoreMutedRef.current = null;
      isDeafenedRef.current = false;
      setIsDeafened(false);
      setLocalMuteState(false);
      window.requestAnimationFrame(playRemoteAudio);
      return;
    }

    setLocalMuteState(!isMutedRef.current);
  }

  function handleToggleDeafen() {
    playRemoteAudio();

    if (isTestingMicrophone) {
      return;
    }

    if (isDeafenedRef.current) {
      const restoredMuted = deafenRestoreMutedRef.current ?? false;
      deafenRestoreMutedRef.current = null;
      isDeafenedRef.current = false;
      setIsDeafened(false);
      setLocalMuteState(restoredMuted);
      window.requestAnimationFrame(playRemoteAudio);
      return;
    }

    deafenRestoreMutedRef.current = isMutedRef.current;
    isDeafenedRef.current = true;
    setIsDeafened(true);
    setLocalMuteState(true);
    setShowVolumeMixer(false);
    window.requestAnimationFrame(playRemoteAudio);
  }

  function removePeerSenderForTrack(track: MediaStreamTrack) {
    for (const peerState of peerConnectionsRef.current.values()) {
      const sender = peerState.peerConnection
        .getSenders()
        .find((item) => item.track?.id === track.id);

      if (sender) {
        peerState.peerConnection.removeTrack(sender);

        if (peerState.screenSender?.track?.id === track.id) {
          peerState.screenSender = null;
        }
      }
    }
  }

  async function handleToggleCamera() {
    playRemoteAudio();

    const stream = localStreamRef.current;
    if (!stream) {
      if (isMediaReady) {
        setMediaNotice(t(languageRef.current, "cameraUnavailable"));
      } else {
        setStartWithCameraOff((value) => !value);
      }
      return;
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      for (const track of videoTracks) {
        removePeerSenderForTrack(track);
        stream.removeTrack(track);
        track.stop();
      }
      setIsCameraEnabled(false);
      attachLocalPreview();
      if (callState !== "idle") {
        socket.emit("media:camera-stopped", {
          roomId,
          from: participantIdRef.current,
        });
        await createOffersForAllPeers();
      }
      return;
    }

    try {
      const track = await requestCameraTrack();
      stream.addTrack(track);
      setIsCameraEnabled(true);
      setMediaNotice("");
      window.requestAnimationFrame(attachLocalPreview);

      if (callState !== "idle") {
        const prioritizeScreen = Boolean(activeScreenShareQuality?.prioritizeScreen);

        for (const peerState of peerConnectionsRef.current.values()) {
          peerState.peerConnection.addTrack(track, stream);
        }
        await Promise.all(
          [...peerConnectionsRef.current.values()].map((peerState) =>
            applyCameraBandwidthProfile(peerState.peerConnection, prioritizeScreen),
          ),
        );
        socket.emit("media:camera-started", {
          roomId,
          from: participantIdRef.current,
        });
        await createOffersForAllPeers();
      }
    } catch (mediaError) {
      setIsCameraEnabled(false);
      setMediaNotice(
        mediaError instanceof DOMException &&
          mediaError.name === "NotAllowedError"
          ? t(languageRef.current, "cameraPermissionDenied")
          : t(languageRef.current, "cameraUnavailable"),
      );
    }
  }

  async function stopScreenShare({
    emit = true,
    renegotiate = true,
  }: StopScreenShareOptions = {}) {
    const screenStream = localScreenStreamRef.current;

    if (!screenStream) {
      return;
    }

    for (const track of screenStream.getTracks()) {
      removePeerSenderForTrack(track);
      track.onended = null;
      track.stop();
    }

    localScreenStreamRef.current = null;
    setIsScreenSharing(false);
    setActiveScreenShareQuality(null);
    setIsApplyingScreenQuality(false);
    setScreenShareStats(null);
    setShowScreenShareSettings(false);
    setActiveScreenShareParticipantId((current) =>
      current === participantIdRef.current ? "" : current,
    );
    setDominantSurface((current) =>
      current === screenSurfaceId(participantIdRef.current) ? null : current,
    );
    setFullscreenSurface((current) =>
      current === screenSurfaceId(participantIdRef.current) ? null : current,
    );

    if (emit) {
      socket.emit("media:screen-stopped", {
        roomId,
        from: participantIdRef.current,
      });
    }

    await Promise.all(
      [...peerConnectionsRef.current.values()].map((peerState) =>
        applyCameraBandwidthProfile(peerState.peerConnection, false),
      ),
    );

    if (renegotiate && callState !== "idle") {
      await createOffersForAllPeers();
    }
  }

  stopScreenShareRef.current = stopScreenShare;

  function canStartScreenShare() {
    if (
      activeScreenShareParticipantId &&
      activeScreenShareParticipantId !== participantIdRef.current
    ) {
      setMediaNotice(t(languageRef.current, "screenShareAlreadyActive"));
      return false;
    }

    if (
      !isScreenShareSupported ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      setMediaNotice(t(languageRef.current, "screenShareUnavailable"));
      return false;
    }

    return true;
  }

  async function startScreenShare(settings: ScreenShareQualitySettings) {
    if (!canStartScreenShare()) {
      return false;
    }

    let capturedStream: MediaStream | null = null;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia(
        screenShareDisplayMediaOptions(settings),
      );
      capturedStream = screenStream;
      for (const track of screenStream.getAudioTracks()) {
        track.contentHint = "music";
      }
      const [screenTrack] = screenStream.getVideoTracks();

      if (!screenTrack) {
        for (const track of screenStream.getTracks()) {
          track.stop();
        }
        return false;
      }

      localScreenStreamRef.current = screenStream;
      screenTrack.onended = () => {
        void stopScreenShare();
      };
      for (const audioTrack of screenStream.getAudioTracks()) {
        audioTrack.onended = () => {
          if (
            !screenStream
              .getAudioTracks()
              .some((track) => track.readyState === "live")
          ) {
            window.requestAnimationFrame(playRemoteAudio);
          }
        };
      }

      const screenSenders: Array<RTCRtpSender | null> = [];

      for (const peerState of peerConnectionsRef.current.values()) {
        peerState.screenSender = peerState.peerConnection.addTrack(
          screenTrack,
          screenStream,
        );
        screenSenders.push(peerState.screenSender);
        for (const audioTrack of screenStream.getAudioTracks()) {
          peerState.peerConnection.addTrack(audioTrack, screenStream);
        }
      }

      setMediaNotice("");
      await applyScreenShareQualityToTrack(settings, screenTrack, screenSenders);

      socket.emit("media:screen-started", {
        roomId,
        from: participantIdRef.current,
        streamId: screenStream.id,
      });

      setIsScreenSharing(true);
      setActiveScreenShareQuality(settings);
      setActiveScreenShareParticipantId(participantIdRef.current);
      setDominantSurface(screenSurfaceId(participantIdRef.current));
      setScreenShareStats(null);

      if (callState !== "idle") {
        await createOffersForAllPeers();
      }

      return true;
    } catch (mediaError) {
      if (localScreenStreamRef.current === capturedStream && capturedStream) {
        await stopScreenShare();
      } else {
        capturedStream?.getTracks().forEach(track => track.stop());
      }

      if (
        mediaError instanceof DOMException &&
        mediaError.name === "NotAllowedError"
      ) {
        return false;
      }

      setMediaNotice(t(languageRef.current, "screenShareUnavailable"));
      return false;
    }
  }

  async function handleToggleScreenShare() {
    playRemoteAudio();

    if (isScreenSharing) {
      await stopScreenShare();
      return;
    }

    if (canStartScreenShare()) {
      setScreenShareQuality(activeScreenShareQuality ?? screenShareQuality);
      setShowScreenShareSettings(true);
    }
  }

  function openScreenShareSettings() {
    setScreenShareQuality(activeScreenShareQuality ?? screenShareQuality);
    setShowScreenShareSettings(true);
  }

  function closeScreenShareSettings() {
    setScreenShareQuality((current) => activeScreenShareQuality ?? current);
    setShowScreenShareSettings(false);
  }

  async function handleStartScreenShareFromSettings() {
    setIsApplyingScreenQuality(true);

    try {
      const started = await startScreenShare(screenShareQuality);

      if (started) {
        setShowScreenShareSettings(false);
      }
    } finally {
      setIsApplyingScreenQuality(false);
    }
  }

  async function handleApplyScreenShareQuality() {
    const screenTrack =
      localScreenStreamRef.current
        ?.getVideoTracks()
        .find((track) => track.readyState === "live") ?? null;

    if (!screenTrack) {
      return;
    }

    setIsApplyingScreenQuality(true);

    try {
      const screenSenders = [...peerConnectionsRef.current.values()].map(
        (peerState) => {
          const sender =
            peerState.screenSender?.track?.id === screenTrack.id
              ? peerState.screenSender
              : findSenderForTrack(peerState.peerConnection, screenTrack);
          peerState.screenSender = sender;
          return sender;
        },
      );

      await applyScreenShareQualityToTrack(
        screenShareQuality,
        screenTrack,
        screenSenders,
      );
      setActiveScreenShareQuality(screenShareQuality);
      setShowScreenShareSettings(false);
    } finally {
      setIsApplyingScreenQuality(false);
    }
  }

  function requestSubtitleServiceStart() {
    if (isStartingSubtitleService) {
      return;
    }

    setIsStartingSubtitleService(true);
    socket.emit(
      "subtitle:start-service",
      {
        roomId,
        participantId: participantIdRef.current,
      },
      async (response: { ok: true } | { ok: false }) => {
        setIsStartingSubtitleService(false);

        if (!response.ok) {
          setError(t(languageRef.current, "subtitleServiceUnavailable"));
          return;
        }

        setIsSubtitleServiceStarted(true);
        await beginLocalSubtitleCapture();
      },
    );
  }

  function handleToggleSubtitleService() {
    playRemoteAudio();

    if (isStartingSubtitleService || !isRoomHost) {
      return;
    }

    if (isSubtitleServiceStarted) {
      socket.emit(
        "subtitle:stop-service",
        {
          roomId,
          participantId: participantIdRef.current,
        },
        (response: { ok: true } | { ok: false }) => {
          if (!response.ok) {
            setError(t(languageRef.current, "subtitleServiceUnavailable"));
            return;
          }

          setIsSubtitleServiceStarted(false);
          stopLocalSubtitleCapture();
        },
      );
      return;
    }

    requestSubtitleServiceStart();
  }

  function requestLeaveConfirmation() {
    stopMicrophoneTestRef.current();
    setShowConversationModeMenu(false);
    setShowVolumeMixer(false);
    setShowSettings(false);
    setShowVoiceSettings(false);
    setShowLayoutPicker(false);
    setShowScreenShareSettings(false);
    setSurfacePickerTarget(null);
    setShowLeaveConfirmation(true);
  }

  function handleLeaveCall() {
    const participantId = participantIdRef.current;

    setShowLeaveConfirmation(false);
    tearDownActiveCall();

    if (socket.connected) {
      socket.emit("room:leave", {
        roomId,
        participantId,
      });
    }

    router.push("/");
  }

  const handleEnterFullscreen = useCallback((surfaceId: MediaSurfaceId) => {
    setFullscreenSurface(surfaceId);
    setDominantSurface(surfaceId);
    setIsFullscreenBottomBarVisible(true);

    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  function handleExitFullscreen() {
    setFullscreenSurface(null);
    fullscreenConversationDragRef.current = null;
    setFullscreenConversationOffset(initialFullscreenConversationOffset);
    setIsFullscreenBottomBarVisible(true);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  const handleOpenSurfacePicker = useCallback((
    surfaceId: MediaSurfaceId,
    slot: MediaSurfacePlacement,
    scope: SurfacePickerTarget["scope"] = "call",
  ) => {
    setSurfacePickerTarget({ scope, slot, surfaceId });
  }, []);

  const handleOpenFullscreenSurfacePicker = useCallback(
    (surfaceId: MediaSurfaceId, slot: MediaSurfacePlacement) => {
      if (slot === "tile") { setFullscreenSurface(surfaceId); setDominantSurface(surfaceId); }
      else handleOpenSurfacePicker(surfaceId, slot, "fullscreen");
    },
    [handleOpenSurfacePicker],
  );

  function handleSelectSurfaceForTarget(selectedSurfaceId: MediaSurfaceId) {
    if (!surfacePickerTarget) {
      return;
    }

    if (surfacePickerTarget.scope === "fullscreen") {
      setFullscreenSurface(selectedSurfaceId);
      setDominantSurface(selectedSurfaceId);
      setSurfacePickerTarget(null);
      return;
    }

    if (surfacePickerTarget.slot === "dominant") {
      setDominantSurface(selectedSurfaceId);
      setSurfacePickerTarget(null);
      return;
    }

    const currentDominantSurfaceId = activeDominantSurfaceId(
      orderedSurfaces,
      dominantSurface,
      mediaLayoutMode,
    );

    if (selectedSurfaceId === currentDominantSurfaceId) {
      setDominantSurface(surfacePickerTarget.surfaceId);
    }

    if (selectedSurfaceId !== surfacePickerTarget.surfaceId) {
      setSurfaceOrder((currentOrder) =>
        swapSurfaceOrder(
          currentOrder,
          orderedSurfaces,
          surfacePickerTarget.surfaceId,
          selectedSurfaceId,
        ),
      );
    }

    setSurfacePickerTarget(null);
  }

  function handleMediaLayoutModeChange(nextMode: MediaLayoutMode) {
    setMediaLayoutMode(nextMode);
    saveMediaLayoutMode(nextMode);
    setShowLayoutPicker(false);
  }

  function handleThemeChange(nextTheme: ThemeMode) {
    setTheme(nextTheme);
    saveTheme(nextTheme);
  }

  function parseVoiceRangeValue(value: string) {
    const nextValue = Number(value);

    if (!Number.isFinite(nextValue)) {
      return null;
    }

    return Math.min(1, Math.max(0, nextValue / 100));
  }

  function clearPendingNoiseReductionCommit() {
    if (
      typeof window !== "undefined" &&
      pendingNoiseReductionTimeoutRef.current !== null
    ) {
      window.clearTimeout(pendingNoiseReductionTimeoutRef.current);
    }

    pendingNoiseReductionTimeoutRef.current = null;
    pendingNoiseReductionValueRef.current = null;
  }

  function commitNoiseReduction(value: number) {
    clearPendingNoiseReductionCommit();
    setNoiseReductionDraft(value);
    setVoiceSettings((current) =>
      Math.abs(current.noiseReduction - value) < 0.001
        ? current
        : {
            ...current,
            noiseReduction: value,
          },
    );
  }

  function scheduleNoiseReductionCommit(value: number) {
    setNoiseReductionDraft(value);
    pendingNoiseReductionValueRef.current = value;

    if (
      typeof window !== "undefined" &&
      pendingNoiseReductionTimeoutRef.current !== null
    ) {
      window.clearTimeout(pendingNoiseReductionTimeoutRef.current);
    }

    if (typeof window === "undefined") {
      commitNoiseReduction(value);
      return;
    }

    pendingNoiseReductionTimeoutRef.current = window.setTimeout(() => {
      const pendingValue = pendingNoiseReductionValueRef.current;
      pendingNoiseReductionTimeoutRef.current = null;
      pendingNoiseReductionValueRef.current = null;

      if (pendingValue === null) {
        return;
      }

      setVoiceSettings((current) =>
        Math.abs(current.noiseReduction - pendingValue) < 0.001
          ? current
          : {
              ...current,
              noiseReduction: pendingValue,
            },
      );
    }, noiseReductionCommitDelayMs);
  }

  function handleVoiceSettingChange(
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) {
    if (field === "microphoneChannelMode") {
      if (!isMicrophoneChannelMode(value)) {
        return;
      }

      setVoiceSettings((current) => ({
        ...current,
        microphoneChannelMode: value,
      }));
      return;
    }

    const nextValue = parseVoiceRangeValue(value);

    if (nextValue === null) {
      return;
    }

    if (field === "noiseReduction") {
      scheduleNoiseReductionCommit(nextValue);
      return;
    }

    setVoiceSettings((current) => ({
      ...current,
      [field]: nextValue,
    }));
  }

  function handleVoiceSettingCommit(
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) {
    if (field !== "noiseReduction") {
      handleVoiceSettingChange(field, value);
      return;
    }

    const nextValue = parseVoiceRangeValue(value);

    if (nextValue === null) {
      return;
    }

    commitNoiseReduction(nextValue);
  }

  async function handleMicrophoneDeviceChange(deviceId: string) {
    const shouldRestartMicrophoneTest = isTestingMicrophone;

    selectedMicrophoneDeviceIdRef.current = deviceId;
    setSelectedMicrophoneDeviceId(deviceId);
    saveMicrophoneDeviceId(deviceId);

    if (!hasLiveAudioTrack(localStreamRef.current)) {
      return;
    }

    if (shouldRestartMicrophoneTest) {
      stopSelfMonitorPlayback();
      setIsTestingMicrophone(false);
    }

    setIsReplacingMicrophone(true);

    try {
      await replaceLocalMicrophoneStream();
    } finally {
      setIsReplacingMicrophone(false);
    }

    if (shouldRestartMicrophoneTest) {
      await restartMicrophoneTest();
    }
  }

  function handleLocalInputVolumeChange(value: string) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(1, Math.max(0, nextVolume / 100));
    setLocalInputVolume(clampedVolume);
    saveVolume(localInputVolumeStorageKey, clampedVolume);
    audioInputGainRef.current?.(clampedVolume);
  }

  function handleMasterOutputVolumeChange(value: string) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(1, Math.max(0, nextVolume / 100));
    setMasterOutputVolume(clampedVolume);
    masterOutputVolumeRef.current = clampedVolume;
    saveVolume(masterOutputVolumeStorageKey, clampedVolume);
    playRemoteAudio();
  }

  function handleRemoteVolumeChange(participantId: string, value: string) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(1, Math.max(0, nextVolume / 100));
    setRemoteVolumes((current) => {
      const next = {
        ...current,
        [participantId]: clampedVolume,
      };
      saveRemoteVolumes(next);
      return next;
    });

    attachStreamToAudio(
      document.querySelector<HTMLAudioElement>(
        `audio[data-participant-id="${participantId}"]`,
      ),
      remoteParticipantsRef.current[participantId]?.audioStream ?? null,
      clampedVolume * masterOutputVolumeRef.current,
      isDeafenedRef.current,
      selectedAudioOutputDeviceIdRef.current,
      remoteAudioMaximumOutputGain,
    );
  }

  function handleScreenShareAudioVolumeChange(value: string) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(1, Math.max(0, nextVolume / 100));
    setScreenShareAudioVolume(clampedVolume);
    screenShareAudioVolumeRef.current = clampedVolume;
    saveVolume(screenShareAudioVolumeStorageKey, clampedVolume);
    playRemoteAudio();
  }

  function handleAudioOutputDeviceChange(deviceId: string) {
    selectedAudioOutputDeviceIdRef.current = deviceId;
    setSelectedAudioOutputDeviceId(deviceId);
    saveAudioOutputDeviceId(deviceId);
    applyAudioOutputDevice(selfMonitorAudioRef.current, deviceId);

    if (isTestingMicrophone) {
      void restartMicrophoneTest();
    }

    playRemoteAudio();
  }

  function stopSelfMonitorPlayback() {
    for (const track of selfMonitorStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }

    selfMonitorStreamRef.current = null;

    if (selfMonitorAudioRef.current) {
      selfMonitorAudioRef.current.pause();
      selfMonitorAudioRef.current.srcObject = null;
    }
  }

  async function playSelfMonitorStream(monitorStream: MediaStream) {
    const audio = selfMonitorAudioRef.current;

    if (!audio) {
      return;
    }

    audio.pause();
    audio.srcObject = null;
    audio.muted = false;
    audio.volume = 1;

    const outputAudio = audio as HTMLAudioElementWithSinkId;
    const outputDeviceId = selectedAudioOutputDeviceIdRef.current;

    if (
      typeof outputAudio.setSinkId === "function" &&
      outputAudio.sinkId !== outputDeviceId
    ) {
      await outputAudio.setSinkId(outputDeviceId).catch(() => undefined);
    }

    audio.srcObject = monitorStream;
    await audio.play().catch(() => undefined);
  }

  function stopMicrophoneTest({ restoreState = true } = {}) {
    stopSelfMonitorPlayback();

    setIsTestingMicrophone(false);

    const restoreSnapshot = micTestRestoreRef.current;
    micTestRestoreRef.current = null;

    if (restoreState && restoreSnapshot) {
      deafenRestoreMutedRef.current = restoreSnapshot.deafenRestoreMuted;
      isDeafenedRef.current = restoreSnapshot.isDeafened;
      setIsDeafened(restoreSnapshot.isDeafened);
      setLocalMuteState(restoreSnapshot.isMuted);
      window.requestAnimationFrame(playRemoteAudio);
    }
  }

  stopMicrophoneTestRef.current = stopMicrophoneTest;

  async function startMicrophoneTest({ restart = false } = {}) {
    if (isTestingMicrophone && !restart) {
      stopMicrophoneTest();
      return;
    }

    if (restart) {
      stopSelfMonitorPlayback();
    }

    let stream = localStreamRef.current;

    if (!hasLiveAudioTrack(stream)) {
      setIsPreparingMedia(true);

      try {
        stream = await requestMedia();
      } catch (mediaError) {
        const message = mediaError instanceof Error ? mediaError.message : "";

        if (message === "microphone-denied") {
          setError(t(languageRef.current, "microphonePermissionDenied"));
        } else if (message === "browser-unsupported") {
          setError(t(languageRef.current, "browserUnsupported"));
        } else {
          setError(t(languageRef.current, "microphoneUnavailable"));
        }

        return;
      } finally {
        setMediaPreparationStep("idle");
        setIsPreparingMedia(false);
      }
    }

    const [audioTrack] = stream.getAudioTracks();

    if (!audioTrack) {
      setError(t(languageRef.current, "microphoneUnavailable"));
      return;
    }

    const monitorTrack = audioTrack.clone();
    monitorTrack.enabled = true;
    const monitorStream = new MediaStream([monitorTrack]);
    selfMonitorStreamRef.current = monitorStream;

    if (!micTestRestoreRef.current) {
      micTestRestoreRef.current = {
        deafenRestoreMuted: deafenRestoreMutedRef.current,
        isDeafened: isDeafenedRef.current,
        isMuted: isMutedRef.current,
      };
    }

    deafenRestoreMutedRef.current = isMutedRef.current;
    isDeafenedRef.current = true;
    setIsDeafened(true);
    setLocalMuteState(true);
    setShowVolumeMixer(false);
    setIsTestingMicrophone(true);

    await playSelfMonitorStream(monitorStream);

    window.requestAnimationFrame(playRemoteAudio);
  }

  async function restartMicrophoneTest() {
    await startMicrophoneTest({ restart: true });
  }

  function closeVoiceSettings() {
    stopMicrophoneTest();
    setShowVoiceSettings(false);
  }

  function openVoiceSettings() {
    setShowSettings(false);
    setShowVoiceSettings(true);
    void refreshMicrophoneDevices();
  }

  function resetConversationDragState() {
    conversationOverlayDragRef.current = null;
    fullscreenConversationDragRef.current = null;
    setConversationOverlayOffset(initialFullscreenConversationOffset);
    setFullscreenConversationOffset(initialFullscreenConversationOffset);
  }

  function handleFullscreenConversationModeChange(
    nextMode: FullscreenConversationMode,
  ) {
    setFullscreenConversationMode(nextMode === "hidden" ? "visible" : nextMode);
    saveFullscreenConversationMode(nextMode);

    if (nextMode !== "overlay") {
      resetConversationDragState();
    }
  }

  async function openCaptionVideoPip() {
    if (typeof document === "undefined" || !language) {
      return false;
    }

    if (captionVideoPipRef.current) {
      drawCaptionVideoPipCanvas({
        emptyText: t(language, "noConversationYet"),
        messages: captionPipMessages,
        title: t(language, "conversation"),
        videoPip: captionVideoPipRef.current,
      });
      setIsCaptionPipOpen(true);
      return true;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 840;
    canvas.height = 560;

    if (typeof canvas.captureStream !== "function") {
      return false;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return false;
    }

    const stream = canvas.captureStream(2);
    const video = document.createElement("video") as VideoPictureInPictureElement;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.height = "1px";
    video.style.left = "-1000px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.style.position = "fixed";
    video.style.top = "0";
    video.style.width = "1px";
    document.body.append(video);

    const videoPip: CaptionVideoPipController = {
      canvas,
      context,
      stream,
      video,
    };
    drawCaptionVideoPipCanvas({
      emptyText: t(language, "noConversationYet"),
      messages: captionPipMessages,
      title: t(language, "conversation"),
      videoPip,
    });

    try {
      await video.play();

      if (
        typeof video.requestPictureInPicture === "function" &&
        (document as DocumentWithVideoPictureInPicture)
          .pictureInPictureEnabled !== false
      ) {
        await video.requestPictureInPicture();
      } else if (typeof video.webkitSetPresentationMode === "function") {
        video.webkitSetPresentationMode("picture-in-picture");
      } else {
        throw new Error("picture-in-picture-unavailable");
      }

      captionVideoPipRef.current = videoPip;
      setIsCaptionPipOpen(true);
      video.addEventListener(
        "leavepictureinpicture",
        () => closeCaptionPipWindow({ restoreOverlay: true }),
        { once: true },
      );
      video.addEventListener("webkitpresentationmodechanged", () => {
        if (
          captionVideoPipRef.current === videoPip &&
          video.webkitPresentationMode !== "picture-in-picture"
        ) {
          closeCaptionPipWindow({ restoreOverlay: true });
        }
      });
      return true;
    } catch {
      for (const track of stream.getTracks()) {
        track.stop();
      }

      video.remove();
      return false;
    }
  }

  async function openCaptionPipWindow() {
    if (typeof window === "undefined" || !language) {
      return false;
    }

    if (captionPipWindowRef.current && !captionPipWindowRef.current.closed) {
      setIsCaptionPipOpen(true);
      return true;
    }

    const documentPictureInPicture = (
      window as WindowWithDocumentPictureInPicture
    ).documentPictureInPicture;

    if (typeof documentPictureInPicture?.requestWindow !== "function") {
      return openCaptionVideoPip();
    }

    try {
      const pipWindow = await documentPictureInPicture.requestWindow({
        disallowReturnToOpener: false,
        height: 560,
        width: 420,
      });

      captionPipWindowRef.current = pipWindow;
      setIsCaptionPipOpen(true);
      pipWindow.addEventListener(
        "pagehide",
        () => {
          if (captionPipWindowRef.current === pipWindow) {
            captionPipWindowRef.current = null;
            setIsCaptionPipOpen(false);
            setConversationDisplayMode((current) =>
              current === "hidden" ? "overlay" : current,
            );
            setFullscreenConversationMode((current) => {
              if (current !== "hidden") {
                return current;
              }

              saveFullscreenConversationMode("overlay");
              return "overlay";
            });
          }
        },
        { once: true },
      );
      renderCaptionPipWindow({
        emptyText: t(language, "noConversationYet"),
        messages: captionPipMessages,
        pipWindow,
        title: t(language, "conversation"),
      });
      return true;
    } catch {
      captionPipWindowRef.current = null;
      setIsCaptionPipOpen(false);
      return openCaptionVideoPip();
    }
  }

  function handleConversationModeMenuToggle(
    placement: ConversationModeMenuPlacement,
  ) {
    setShowVolumeMixer(false);
    setConversationModeMenuPlacement(placement);
    setConversationModeMenuPosition(null);
    setShowConversationModeMenu((current) =>
      current && conversationModeMenuPlacement === placement ? false : true,
    );
  }

  async function handleSelectConversationMode(option: ConversationModeOption) {
    setShowVolumeMixer(false);
    setShowConversationModeMenu(false);
    setConversationModeMenuPosition(null);

    if (option === "panel") {
      closeCaptionPipWindow();
      setConversationDisplayMode("panel");
      resetConversationDragState();
      handleFullscreenConversationModeChange("visible");
      return;
    }

    if (option === "overlay") {
      closeCaptionPipWindow();
      setConversationDisplayMode("overlay");
      handleFullscreenConversationModeChange("overlay");
      return;
    }

    if (option === "hidden") {
      closeCaptionPipWindow();
      setConversationDisplayMode("panel");
      resetConversationDragState();
      handleFullscreenConversationModeChange("visible");
      return;
    }

    if (!isCaptionPipSupported) {
      setMediaNotice(t(languageRef.current, "captionsAlwaysOnTopUnavailable"));
      return;
    }

    const previousConversationMode = conversationDisplayMode;
    const previousFullscreenConversationMode = fullscreenConversationMode;
    setConversationDisplayMode("panel");
    setFullscreenConversationMode("visible");
    saveFullscreenConversationMode("overlay");
    resetConversationDragState();
    const isPipOpen = await openCaptionPipWindow();

    if (!isPipOpen) {
      setConversationDisplayMode(previousConversationMode);
      setFullscreenConversationMode(previousFullscreenConversationMode);
      saveFullscreenConversationMode(previousFullscreenConversationMode);
      setMediaNotice(t(languageRef.current, "captionsAlwaysOnTopUnavailable"));
    }
  }

  function getConversationDragBounds(
    element: HTMLElement | null,
    offset: FullscreenConversationOffset,
  ) {
    if (typeof window === "undefined") {
      return {
        maxX: 0,
        maxY: 0,
        minX: 0,
        minY: 0,
      };
    }

    const rect = element?.getBoundingClientRect();
    const viewportPadding = 8;

    if (!rect) {
      return {
        maxX: Math.max(0, window.innerWidth - 160),
        maxY: Math.max(0, window.innerHeight - 120),
        minX: -Math.max(0, window.innerWidth - 160),
        minY: -Math.max(0, window.innerHeight - 120),
      };
    }

    const baseLeft = rect.left - offset.x;
    const baseRight = rect.right - offset.x;
    const baseTop = rect.top - offset.y;
    const baseBottom = rect.bottom - offset.y;

    return {
      maxX: window.innerWidth - viewportPadding - baseRight,
      maxY: window.innerHeight - viewportPadding - baseBottom,
      minX: viewportPadding - baseLeft,
      minY: viewportPadding - baseTop,
    };
  }

  function getConversationOverlayDragBounds() {
    return getConversationDragBounds(
      conversationOverlayRef.current,
      conversationOverlayOffset,
    );
  }

  function getFullscreenConversationDragBounds() {
    return getConversationDragBounds(
      fullscreenConversationRef.current,
      fullscreenConversationOffset,
    );
  }

  function handleConversationOverlayDragStart(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (conversationDisplayMode !== "overlay") {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    conversationOverlayDragRef.current = {
      originX: conversationOverlayOffset.x,
      originY: conversationOverlayOffset.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function handleConversationOverlayDragMove(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const dragState = conversationOverlayDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const bounds = getConversationOverlayDragBounds();
    setConversationOverlayOffset({
      x: clampNumber(
        dragState.originX + event.clientX - dragState.startX,
        bounds.minX,
        bounds.maxX,
      ),
      y: clampNumber(
        dragState.originY + event.clientY - dragState.startY,
        bounds.minY,
        bounds.maxY,
      ),
    });
  }

  function handleConversationOverlayDragEnd(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const dragState = conversationOverlayDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    conversationOverlayDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleFullscreenConversationDragStart(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (fullscreenConversationMode !== "overlay") {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    fullscreenConversationDragRef.current = {
      originX: fullscreenConversationOffset.x,
      originY: fullscreenConversationOffset.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function handleFullscreenConversationDragMove(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const dragState = fullscreenConversationDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const bounds = getFullscreenConversationDragBounds();
    setFullscreenConversationOffset({
      x: clampNumber(
        dragState.originX + event.clientX - dragState.startX,
        bounds.minX,
        bounds.maxX,
      ),
      y: clampNumber(
        dragState.originY + event.clientY - dragState.startY,
        bounds.minY,
        bounds.maxY,
      ),
    });
  }

  function handleFullscreenConversationDragEnd(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const dragState = fullscreenConversationDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    fullscreenConversationDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const selectedScreenResolution = useMemo(() => {
    const option = screenShareResolutionOptions.find(
      (item) =>
        item.width === screenShareQuality.width &&
        item.height === screenShareQuality.height,
    );

    return option ? `${option.width}x${option.height}` : "custom";
  }, [screenShareQuality.height, screenShareQuality.width]);

  function handleSelectScreenSharePreset(presetId: ScreenSharePresetId) {
    if (presetId === "custom") {
      setScreenShareQuality((current) => ({ ...current, presetId: "custom" }));
      return;
    }

    setScreenShareQuality(screenSharePresetDefaults[presetId]);
  }

  function updateScreenShareQuality(
    patch: Partial<Omit<ScreenShareQualitySettings, "presetId">>,
  ) {
    setScreenShareQuality((current) => ({
      ...current,
      ...patch,
      presetId: "custom",
    }));
  }

  function handleScreenShareNumberChange(
    field: "width" | "height" | "frameRate" | "bitrateKbps",
    value: string,
  ) {
    const nextValue = Number(value);

    if (!Number.isFinite(nextValue)) {
      return;
    }

    const limits: Record<
      "width" | "height" | "frameRate" | "bitrateKbps",
      [number, number]
    > = {
      bitrateKbps: [500, 30000],
      frameRate: [5, 60],
      height: [360, 2160],
      width: [640, 3840],
    };
    const [min, max] = limits[field];
    updateScreenShareQuality({
      [field]: clampQualityNumber(nextValue, min, max),
    });
  }

  function handleScreenShareResolutionChange(value: string) {
    const option = screenShareResolutionOptions.find(
      (item) => `${item.width}x${item.height}` === value,
    );

    if (!option) {
      setScreenShareQuality((current) => ({ ...current, presetId: "custom" }));
      return;
    }

    updateScreenShareQuality({
      height: option.height,
      width: option.width,
    });
  }

  const statusText = useMemo(() => {
    if (!language) {
      return "";
    }

    if (callState === "connecting") {
      return t(language, "connecting");
    }

    if (callState === "waiting") {
      return t(language, "waitingForOthers");
    }

    if (callState === "connected") {
      return t(language, "connected");
    }

    if (callState === "reconnecting") {
      return t(language, "reconnecting");
    }

    if (callState === "disconnected") {
      return t(language, "disconnected");
    }

    return roomInfo?.isCreator ? t(language, "roomSetup") : t(language, "joinCall");
  }, [callState, language, roomInfo?.isCreator]);

  const surfaces: MediaSurface[] = useMemo(() => {
    const localId = participantIdRef.current || "local";
    const shouldCheckLocalVideo =
      isMediaReady || isCameraEnabled || callState !== "idle";
    const localVideoStream =
      shouldCheckLocalVideo &&
      localStreamRef.current &&
      hasLiveVideoTrack(localStreamRef.current)
        ? localStreamRef.current
        : null;
    const localHasVideo = Boolean(localVideoStream);
    const nextSurfaces: MediaSurface[] = [
      {
        hasVideo: localHasVideo,
        id: participantSurfaceId(localId),
        isLocal: true,
        isSpeaking: isLocalSpeaking,
        isMuted,
        isDeafened,
        kind: "participant",
        label: displayName || t(language ?? "en", "localVideo"),
        status: isDeafened
          ? t(language ?? "en", "deafened")
          : isMuted
            ? t(language ?? "en", "muted")
            : "",
        stream: localVideoStream,
      },
    ];

    if (isScreenSharing && localScreenStreamRef.current) {
      nextSurfaces.unshift({
        id: screenSurfaceId(localId),
        isLocal: true,
        kind: "screen",
        label: t(language ?? "en", "localScreen"),
        status: t(language ?? "en", "screenShareOn"),
        stream: localScreenStreamRef.current,
      });
    }

    for (const participant of remoteList) {
      const participantHasVideo = hasLiveVideoTrack(participant.cameraStream);

      if (participant.hasScreenShare) {
        nextSurfaces.unshift({
          id: screenSurfaceId(participant.participantId),
          kind: "screen",
          label: `${participant.displayName} ${t(language ?? "en", "sharedScreenSuffix")}`,
          status: t(language ?? "en", "screenShareOn"),
          stream: participant.screenStream,
        });
      }

      nextSurfaces.push({
        hasVideo: participantHasVideo,
        id: participantSurfaceId(participant.participantId),
        isSpeaking: participant.isSpeaking,
        kind: "participant",
        label: participant.displayName,
        status: "",
        stream: participant.cameraStream,
      });
    }

    return nextSurfaces;
  }, [
    callState,
    displayName,
    isCameraEnabled,
    isDeafened,
    isLocalSpeaking,
    isMediaReady,
    isMuted,
    isScreenSharing,
    language,
    remoteList,
  ]);
  const orderedSurfaces = useMemo(
    () => orderMediaSurfaces(surfaces, surfaceOrder),
    [surfaces, surfaceOrder],
  );
  const fullscreenSurfaceKind = fullscreenSurface
    ? orderedSurfaces.find((surface) => surface.id === fullscreenSurface)?.kind ?? null
    : null;
  const fullscreenSurfaceCount = orderedSurfaces.filter(
    (surface) => surface.stream || surface.kind === "participant",
  ).length;
  const fullscreenHasBottomBar =
    fullscreenSurfaceKind === "screen" && fullscreenSurfaceCount > 1;
  const surfacePickerSelectedId = surfacePickerTarget?.surfaceId ?? null;
  const surfacePickerTitleKey =
    surfacePickerTarget?.slot === "dominant"
      ? "chooseDominantView"
      : "chooseSmallView";
  const isSetupCameraOn = isMediaReady ? isCameraEnabled : !startWithCameraOff;

  const captionSpeakerNames = useMemo(() => {
    const names: Record<string, string> = {
      [participantIdRef.current]: displayName || t(language ?? "en", "localVideo"),
    };

    for (const participant of remoteList) {
      names[participant.participantId] = participant.displayName;
    }

    return names;
  }, [displayName, language, remoteList]);

  const captionPipMessages = useMemo(() => {
    const localName = displayName || t(language ?? "en", "localVideo");
    const localMessages = localCaptionLog.map((caption): CaptionPipMessage => ({
      id: captionPipMessageId(caption, true),
      isLocal: true,
      originalText: caption.originalText,
      speakerName: localName,
      timestamp: caption.timestamp,
      translatedText: caption.translatedText,
    }));
    const remoteMessages = remoteCaptionLog.map((caption): CaptionPipMessage => ({
      id: captionPipMessageId(caption, false),
      isLocal: false,
      originalText: caption.originalText,
      speakerName:
        captionSpeakerNames[caption.speakerId] ?? t(language ?? "en", "participants"),
      timestamp: caption.timestamp,
      translatedText: caption.translatedText,
    }));
    const withLocalLive = appendCaptionPipMessage(
      [...localMessages, ...remoteMessages],
      localPartialCaption,
      true,
      localName,
    );

    return withLocalLive.sort((first, second) => first.timestamp - second.timestamp);
  }, [
    captionSpeakerNames,
    displayName,
    language,
    localCaptionLog,
    localPartialCaption,
    remoteCaptionLog,
  ]);

  useEffect(() => {
    const pipWindow = captionPipWindowRef.current;
    const videoPip = captionVideoPipRef.current;

    if (!language || !pipWindow || pipWindow.closed) {
      if (pipWindow?.closed) {
        captionPipWindowRef.current = null;
        setIsCaptionPipOpen(false);
      }

      if (language && videoPip) {
        drawCaptionVideoPipCanvas({
          emptyText: t(language, "noConversationYet"),
          messages: captionPipMessages,
          title: t(language, "conversation"),
          videoPip,
        });
      }

      return;
    }

    renderCaptionPipWindow({
      emptyText: t(language, "noConversationYet"),
      messages: captionPipMessages,
      pipWindow,
      title: t(language, "conversation"),
    });

    if (videoPip) {
      drawCaptionVideoPipCanvas({
        emptyText: t(language, "noConversationYet"),
        messages: captionPipMessages,
        title: t(language, "conversation"),
        videoPip,
      });
    }
  }, [captionPipMessages, language]);

  const selectedConversationModeOption: ConversationModeOption = isCaptionPipOpen
    ? "alwaysOnTop"
    : conversationDisplayMode;

  function renderConversationModeMenu() {
    if (!language || !showConversationModeMenu) {
      return null;
    }

    const conversationModeOptions = [
      {
        icon: Captions,
        id: "panel" as const,
        label: t(language, "conversationModePanel"),
      },
      {
        icon: MessageSquare,
        id: "overlay" as const,
        label: t(language, "conversationModeOverlay"),
      },
      {
        icon: PictureInPicture2,
        id: "alwaysOnTop" as const,
        label: t(language, "conversationModeAlwaysOnTop"),
        title: isCaptionPipSupported
          ? t(language, "captionsAlwaysOnTop")
          : t(language, "captionsAlwaysOnTopUnavailable"),
      },
    ];
    const menuStyle = conversationModeMenuPosition
      ? ({
          "--conversation-menu-arrow-left": `${conversationModeMenuPosition.arrowLeft}px`,
          left: `${conversationModeMenuPosition.left}px`,
          top: `${conversationModeMenuPosition.top}px`,
          width: `${conversationModeMenuPosition.width}px`,
        } as CSSProperties)
      : ({
          left: 0,
          top: 0,
          visibility: "hidden",
          width: "min(17.5rem, calc(100vw - 1rem))",
        } as CSSProperties);

    return (
      <div
        ref={conversationModeMenuRef}
        id={`conversation-mode-menu-${conversationModeMenuPlacement}`}
        role="menu"
        aria-label={t(language, "conversationModeMenu")}
        className={`conversation-mode-popover is-${conversationModeMenuPlacement}`}
        data-conversation-mode-menu-root
        style={menuStyle}
      >
        {conversationModeOptions.map((option) => {
          const Icon = option.icon;
          const isSelected = selectedConversationModeOption === option.id;
          const isUnavailable =
            option.id === "alwaysOnTop" && !isCaptionPipSupported;

          return (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              aria-disabled={isUnavailable}
              disabled={isUnavailable}
              title={option.title}
              onClick={() => void handleSelectConversationMode(option.id)}
              className={`conversation-mode-option ${
                isSelected ? "is-selected" : ""
              } ${isUnavailable ? "is-unavailable" : ""}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  const conversationModeMenuPortal =
    typeof document !== "undefined" && showConversationModeMenu
      ? createPortal(renderConversationModeMenu(), document.body)
      : null;

  const mixerChannels = language
    ? [
        {
          ariaLabel: t(language, "mixerMicInputVolume"),
          id: "local-input",
          kind: "input",
          label: t(language, "mixerMicInput"),
          onChange: handleLocalInputVolumeChange,
          value: Math.round(localInputVolume * 100),
        },
        {
          ariaLabel: t(language, "mixerMasterOutputVolume"),
          id: "master-output",
          kind: "master",
          label: t(language, "mixerMasterOutput"),
          onChange: handleMasterOutputVolumeChange,
          value: Math.round(masterOutputVolume * 100),
        },
        {
          ariaLabel: t(language, "mixerScreenShareAudioVolume"),
          id: "screen-share-audio",
          kind: "screen",
          label: t(language, "mixerScreenShareAudio"),
          onChange: handleScreenShareAudioVolumeChange,
          value: Math.round(screenShareAudioVolume * 100),
        },
        ...remoteList.map((participant) => ({
          ariaLabel: `${participant.displayName} ${t(language, "volume")}`,
          id: participant.participantId,
          kind: "remote",
          label: participant.displayName,
          onChange: (value: string) =>
            handleRemoteVolumeChange(participant.participantId, value),
          value: Math.round(
            (remoteVolumes[participant.participantId] ?? 1) * 100,
          ),
        })),
      ]
    : [];

  const volumeMixer =
    language && showVolumeMixer ? (
      <div
        ref={volumeMixerRef}
        id="participant-volume-mixer"
        role="dialog"
        aria-label={t(language, "participantAudio")}
        className="call-control-mixer-popover"
      >
        <div className="call-control-mixer-header">
          <div className="garden-bubble grid h-10 w-10 shrink-0 place-items-center rounded-full">
            <Volume2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2>{t(language, "audioMixerTitle")}</h2>
          </div>
          <button type="button" className="garden-icon-button" aria-label={t(language, "closeSettings")} onClick={() => { setShowVolumeMixer(false); (fullscreenSurface ? fullscreenVolumeButtonRef : volumeButtonRef).current?.focus(); }}>
            <X aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          className="call-control-mixer-voice-button"
          onClick={() => {
            setShowVolumeMixer(false);
            setShowVoiceSettings(true);
            void refreshMicrophoneDevices();
          }}
        >
          <span className="garden-bubble grid h-9 w-9 shrink-0 place-items-center rounded-full">
            <Mic className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="call-control-mixer-voice-copy">
            <strong>{t(language, "voiceSettingsTitle")}</strong>
            <small>{t(language, "voiceSettingsSummary")}</small>
          </span>
          <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
        <div className="audio-mixer-faders" role="group" aria-label={t(language, "audioMixerTitle")}>
          {mixerChannels.map((channel) => (
            <label
              className={`audio-mixer-channel is-${channel.kind}`}
              key={channel.id}
            >
              <span className="audio-mixer-name">{channel.label}</span>
              <span className="audio-mixer-value">{channel.value}%</span>
              <input
                aria-label={channel.ariaLabel}
                className="audio-mixer-slider"
                style={{ "--range-fill": `${channel.value}%` } as CSSProperties}
                max="100"
                min="0"
                onChange={(event) => channel.onChange(event.target.value)}
                step="1"
                type="range"
                value={channel.value}
              />
            </label>
          ))}
        </div>
      </div>
    ) : null;

  const captionServiceControl = language ? (
    isRoomHost ? (
      <button
        type="button"
        className="paper-caption-toggle"
        onClick={handleToggleSubtitleService}
        disabled={isStartingSubtitleService}
        aria-pressed={isSubtitleServiceStarted}
        aria-busy={isStartingSubtitleService}
        title={t(language, isSubtitleServiceStarted ? "stopSubtitleService" : "startSubtitleService")}
      >
        <Captions aria-hidden="true" />
        <span>{t(language, isStartingSubtitleService ? "startingControl" : isSubtitleServiceStarted ? "captionsOn" : "captionsOff")}</span>
      </button>
    ) : (
      <span className="paper-caption-status"><Captions aria-hidden="true" />{t(language, isSubtitleServiceStarted ? "captionsOn" : "captionsOff")}</span>
    )
  ) : null;

  const activeControls = callState !== "idle" && language ? (
    <CallControls
      language={language}
      muted={isMuted} deafened={isDeafened} cameraOn={isCameraEnabled}
      sharing={isScreenSharing}
      shareDisabled={!isScreenShareSupported || Boolean(activeScreenShareParticipantId && activeScreenShareParticipantId !== participantIdRef.current)}
      moreOpen={showMoreControls} onMoreChange={setShowMoreControls}
      onMute={handleToggleMute} onDeafen={handleToggleDeafen} onCamera={handleToggleCamera}
      onShare={() => { setShowMoreControls(false); void handleToggleScreenShare(); }}
      onAudio={() => { setShowConversationModeMenu(false); setShowVolumeMixer((current) => !current); }}
      onVoice={openVoiceSettings}
      onView={() => setShowLayoutPicker(true)}
      onConversation={() => handleConversationModeMenuToggle("dock")}
      onQuality={openScreenShareSettings} onSettings={() => setShowSettings(true)}
      onLeave={requestLeaveConfirmation}
      audioRef={volumeButtonRef} conversationRef={dockConversationModeButtonRef}
      audioOpen={showVolumeMixer} conversationOpen={showConversationModeMenu}
    >
      {fullscreenSurface ? null : volumeMixer}
    </CallControls>
  ) : null;

  const connectionPathRows = useMemo(
    () =>
      remoteList.map(
        (participant) =>
          connectionPathSnapshots[participant.participantId] ?? {
            displayName: participant.displayName,
            participantId: participant.participantId,
            path: "unknown" as const,
            updatedAt: 0,
          },
      ),
    [connectionPathSnapshots, remoteList],
  );
  const connectionPathSummary = useMemo(
    () => summarizeConnectionPath(connectionPathRows, remoteList.length),
    [connectionPathRows, remoteList.length],
  );

  if (!language) {
    return <LanguageGate onSelect={handleLanguageSelect} />;
  }

  if (!displayName) {
    return (
      <UsernameGate
        language={language}
        onBack={handleBackToLanguage}
        onSubmit={handleUsernameSubmit}
      />
    );
  }

  return (
    <main
      data-more-open={showMoreControls}
      className={`sakura-home call-room-scene garden-scene safe-bottom min-h-dvh px-4 py-4 sm:px-6 lg:px-8 ${
        callState === "idle" ? (!isMediaReady ? "call-scene-permissions" : "") : "call-scene-active"
      } ${
        callState !== "idle" && conversationDisplayMode === "hidden"
          ? "is-conversation-hidden"
          : ""
      }`}
    >
      {remoteList.map((participant) => (
        <CallAudioSink
          key={participant.participantId}
          maximumGain={remoteAudioMaximumOutputGain}
          muted={isDeafened}
          outputDeviceId={selectedAudioOutputDeviceId}
          participantId={participant.participantId}
          stream={participant.audioStream}
          type="participant"
          volume={
            (remoteVolumes[participant.participantId] ?? 1) *
            masterOutputVolume
          }
        />
      ))}
      {remoteList.map((participant) => (
        <CallAudioSink
          key={`${participant.participantId}-screen-audio`}
          maximumGain={screenShareAudioMaximumOutputGain}
          muted={isDeafened}
          outputDeviceId={selectedAudioOutputDeviceId}
          participantId={participant.participantId}
          stream={participant.screenAudioStream}
          type="screen"
          volume={screenShareAudioVolume * masterOutputVolume}
        />
      ))}
      <audio ref={selfMonitorAudioRef} autoPlay playsInline />
      {conversationModeMenuPortal}

      {showSubtitleNotice && language ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-40 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:px-6 lg:px-8">
          <div
            key={subtitleNoticeId}
            className="subtitle-service-toast garden-panel mx-auto max-w-md overflow-hidden"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="garden-bubble grid h-9 w-9 shrink-0 place-items-center rounded-full">
                <Flower2 className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="garden-text-ink text-sm font-black">
                {t(language, subtitleNoticeKey)}
              </p>
            </div>
            <span className="subtitle-service-toast-bar" aria-hidden="true" />
          </div>
        </div>
      ) : null}

      <div
        className={`call-shell mx-auto grid w-full gap-3 ${
          callState === "idle"
            ? `call-shell-setup max-w-6xl ${isMediaReady ? "is-media-ready" : ""}`
            : "call-shell-live max-w-[min(96rem,100%)]"
        } ${
          callState === "idle"
            ? "overflow-visible"
            : "call-shell-active overflow-hidden"
        }`}
      >
        <section
          className={`grid min-h-0 min-w-0 gap-3 ${
            callState === "idle" ? "" : "call-active-layout"
          }`}
        >
          <header
            className={`call-topbar garden-panel flex flex-wrap items-center justify-between gap-3 ${
              callState === "idle" ? "" : "is-active-call"
            } ${callState === "idle" ? "p-4 sm:p-5" : "p-3 sm:p-4"}`}
          >
            <div className="call-topbar-copy min-w-0 flex-1">
              <div className="paper-call-brand"><Flower2 aria-hidden="true" /><span>{t(language, "appName")}</span></div>
              <div className="paper-call-status"><span className="call-topbar-status-dot" aria-hidden="true" />{statusText}<span className="paper-participant-count">{participantCount} / {maxParticipants}</span></div>
            </div>
            <div
              className={`call-topbar-actions flex min-w-0 shrink-0 items-center gap-2 ${
                hostRoomCode ? "has-room-code" : ""
              }`}
            >
              {hostRoomCode ? (
                <button
                  type="button"
                  aria-label={
                    isCodeCopied
                      ? t(language, "copied")
                      : t(language, "copyRoomCode")
                  }
                  title={
                    isCodeCopied
                      ? t(language, "copied")
                      : t(language, "copyRoomCode")
                  }
                  onClick={handleCopyCode}
                  className="garden-button garden-button-quiet room-code-button h-12 min-w-0 flex-1 gap-2 px-4 text-sm sm:flex-none sm:text-base"
                >
                  <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate whitespace-nowrap font-black">
                    {hostRoomCode}
                  </span>
                </button>
              ) : null}
              {callState === "idle" ? (
                <button
                  type="button"
                  aria-label={t(language, "back")}
                  onClick={handleBackToHome}
                  className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label={t(language, "openSettings")}
                onClick={() => setShowSettings(true)}
                className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
              >
                <Settings className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </header>

          {callState === "idle" ? (
            <>
              {!isMediaReady ? (
                <section className="garden-panel setup-permission-panel p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
                      <Mic className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="garden-text-ink text-lg font-black">
                        {t(language, "permissionsTitle")}
                      </h2>
                      <p className="garden-muted mt-1 text-sm font-bold leading-snug">
                        {t(language, "permissionsHelp")}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handlePrepareMedia}
                    disabled={isPreparingMedia}
                    className="garden-button garden-button-primary setup-permission-button mt-4 h-14 w-full gap-2 px-5 text-base"
                  >
                    <Mic className="h-5 w-5" aria-hidden="true" />
                    <span>
                      {isPreparingMedia
                        ? t(
                            language,
                            mediaPreparationStatusKeys[mediaPreparationStep],
                          )
                        : t(language, "allowPermissions")}
                    </span>
                  </button>
                </section>
              ) : (
                <section className="garden-panel setup-ready-stage p-4 sm:p-5">
                  <div className="setup-ready-grid">
                    <div className="setup-preview-column">
                      <div className="setup-ready-banner">
                        <Mic className="h-5 w-5" aria-hidden="true" />
                        <span>{t(language, "permissionsReady")}</span>
                      </div>
                      <div className="setup-preview">
                        <div
                          className={`setup-preview-video ${
                            isCameraEnabled ? "has-video" : ""
                          }`}
                        >
                          {isCameraEnabled ? (
                            <video
                              ref={(element) => {
                                localVideoRef.current = element;
                                attachLocalPreview();
                              }}
                              autoPlay
                              muted
                              playsInline
                              className="setup-preview-stream"
                            />
                          ) : (
                            <div className="setup-preview-placeholder">
                              <CameraOff className="h-6 w-6" aria-hidden="true" />
                              <span>{t(language, "cameraOff")}</span>
                            </div>
                          )}
                        </div>
                        <div className="setup-preview-audio-test">
                          <div className="setup-preview-audio-copy min-w-0">
                            <strong>{t(language, "micTestTitle")}</strong>
                            <small>{t(language, "previewMicTestHelp")}</small>
                          </div>
                          <button
                            type="button"
                            onClick={() => void startMicrophoneTest()}
                            disabled={isPreparingMedia || isReplacingMicrophone}
                            className={`garden-button ${
                              isTestingMicrophone
                                ? "garden-button-secondary"
                                : "garden-button-primary"
                            } setup-preview-test-button`}
                          >
                            {isTestingMicrophone ? (
                              <MicOff className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Mic className="h-4 w-4" aria-hidden="true" />
                            )}
                            <span>
                              {isTestingMicrophone
                                ? t(language, "stopMicTest")
                                : t(language, "startMicTest")}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="setup-control-column">
                      <DeviceMenu label={t(language, "audioDevicesTitle")}>
                        <div className="setup-device-grid">
                          <label className="setup-device-field">
                            <span>{t(language, "microphoneDevice")}</span>
                            <select
                              value={selectedMicrophoneDeviceId}
                              onChange={(event) => {
                                void handleMicrophoneDeviceChange(
                                  event.target.value,
                                );
                              }}
                              disabled={isPreparingMedia || isReplacingMicrophone}
                              className="garden-select"
                            >
                              <option value="">
                                {t(language, "defaultMicrophoneDevice")}
                              </option>
                              {selectedMicrophoneDeviceId &&
                              !microphoneDevices.some(
                                (device) =>
                                  device.deviceId === selectedMicrophoneDeviceId,
                              ) ? (
                                <option value={selectedMicrophoneDeviceId}>
                                  {t(language, "selectedMicrophoneDevice")}
                                </option>
                              ) : null}
                              {microphoneDevices.map((device, index) => (
                                <option
                                  key={device.deviceId || index}
                                  value={device.deviceId}
                                >
                                  {device.label ||
                                    `${t(language, "microphoneDevice")} ${index + 1}`}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="setup-device-field">
                            <span>{t(language, "audioOutputDevice")}</span>
                            <select
                              value={selectedAudioOutputDeviceId}
                              onChange={(event) =>
                                handleAudioOutputDeviceChange(event.target.value)
                              }
                              disabled={
                                isPreparingMedia ||
                                !isAudioOutputSelectionSupported
                              }
                              className="garden-select"
                            >
                              <option value="">
                                {t(language, "defaultAudioOutputDevice")}
                              </option>
                              {selectedAudioOutputDeviceId &&
                              !audioOutputDevices.some(
                                (device) =>
                                  device.deviceId === selectedAudioOutputDeviceId,
                              ) ? (
                                <option value={selectedAudioOutputDeviceId}>
                                  {t(language, "selectedAudioOutputDevice")}
                                </option>
                              ) : null}
                              {audioOutputDevices.map((device, index) => (
                                <option
                                  key={device.deviceId || index}
                                  value={device.deviceId}
                                >
                                  {device.label ||
                                    `${t(language, "audioOutputDevice")} ${index + 1}`}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="setup-device-field">
                            <span>{t(language, "microphoneChannelMode")}</span>
                            <select
                              value={voiceSettings.microphoneChannelMode}
                              onChange={(event) =>
                                handleVoiceSettingChange(
                                  "microphoneChannelMode",
                                  event.target.value,
                                )
                              }
                              disabled={isPreparingMedia}
                              className="garden-select"
                            >
                              {microphoneChannelModes.map((mode) => (
                                <option key={mode} value={mode}>
                                  {microphoneChannelModeLabel(language, mode)}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        {!isAudioOutputSelectionSupported ? (
                          <p className="setup-device-note">
                            {t(language, "audioOutputDeviceUnsupported")}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          onClick={openVoiceSettings}
                          disabled={isPreparingMedia}
                          className="garden-button garden-button-quiet setup-voice-settings-button"
                        >
                          <SlidersHorizontal
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <span>{t(language, "voiceSettingsButton")}</span>
                        </button>
                      </DeviceMenu>
                    </div>

                    <div className="setup-action-column">
                      <div className="setup-start-options grid gap-3">
                        <p className="garden-text-muted text-sm font-black">
                          {t(language, "mediaStartOptions")}
                        </p>
                        <div className="setup-start-grid grid grid-cols-1 gap-3">
                          <button
                            type="button"
                            onClick={handleToggleMute}
                            disabled={isPreparingMedia}
                            className={`garden-button setup-state-button h-14 gap-2 px-3 text-sm sm:text-base ${
                              isMuted ? "is-off" : "is-on"
                            }`}
                          >
                            {isMuted ? (
                              <MicOff className="h-5 w-5" aria-hidden="true" />
                            ) : (
                              <Mic className="h-5 w-5" aria-hidden="true" />
                            )}
                            {isMuted
                              ? t(language, "startMuted")
                              : t(language, "startUnmuted")}
                          </button>
                          <button
                            type="button"
                            onClick={handleToggleCamera}
                            disabled={isPreparingMedia}
                            className={`garden-button setup-state-button h-14 gap-2 px-3 text-sm sm:text-base ${
                              isSetupCameraOn ? "is-on" : "is-off"
                            }`}
                          >
                            {isSetupCameraOn ? (
                              <Camera className="h-5 w-5" aria-hidden="true" />
                            ) : (
                              <CameraOff
                                className="h-5 w-5"
                                aria-hidden="true"
                              />
                            )}
                            {isSetupCameraOn
                              ? t(language, "startCameraOn")
                              : t(language, "startCameraOff")}
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={
                          !roomInfo || !hasLiveAudioTrack(localStreamRef.current)
                        }
                        onClick={() => void handleJoinCall()}
                        className="garden-button garden-button-primary setup-join-button h-16 w-full px-5 text-xl"
                      >
                        {t(language, "joinCall")}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {error || mediaNotice ? (
                <div className="grid gap-2">
                  {error ? (
                    <p className="garden-alert-error rounded-lg px-4 py-3 text-sm font-black">
                      {error}
                    </p>
                  ) : null}
                  {mediaNotice ? (
                    <p role="status" className="garden-alert-warning rounded-lg px-4 py-3 text-sm font-black">
                      {mediaNotice}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div
                className="active-call-workspace"
              >
                <div className="active-media-column">
                  {fullscreenSurface ? null : (
                    <VideoGrid
                      language={language}
                      layoutMode={mediaLayoutMode}
                      surfaces={orderedSurfaces}
                      dominantSurfaceId={dominantSurface}
                      onFullscreenSurface={handleEnterFullscreen}
                      onSelectSurface={handleOpenSurfacePicker}
                    />
                  )}

                  {error || mediaNotice ? (
                    <div className="grid gap-2">
                      {error ? (
                        <p className="garden-alert-error rounded-lg px-4 py-3 text-sm font-black">
                          {error}
                        </p>
                      ) : null}
                      {mediaNotice ? (
                        <p role="status" className="garden-alert-warning rounded-lg px-4 py-3 text-sm font-black">
                          {mediaNotice}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <aside className="call-conversation-panel is-panel" aria-label={t(language, "conversation")}>
                    <ConversationPanel
                attachmentDraft={attachmentDraft}
                onAttach={attachChatFile}
                onRemoveAttachment={removeChatAttachment}
                fileError={fileError}
                downloads={downloads}
                onDownload={downloadChatFile}
                availableFileSenders={Object.keys(remoteParticipants)}
                chatMessages={chatMessages}
                localParticipantId={participantIdRef.current}
                draft={chatDraft}
                onDraftChange={setChatDraft}
                onSend={sendChatMessage}
                isSending={isChatSending}
                sendError={chatSendError}
                      controls={
                        <div className="paper-caption-controls">
                          <select aria-label={t(language, "changeLanguage")} value={language} onChange={(event) => { if (isSupportedLanguage(event.target.value)) handleLanguageSelect(event.target.value); }}>
                            {supportedLanguageOptions.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                          </select>
                          {captionServiceControl}
                        </div>
                      }
                      language={language}
                      localCaptionLog={localCaptionLog}
                      localName={displayName}
                      localPartialCaption={localPartialCaption}
                      remoteCaptionLog={remoteCaptionLog}
                      remoteName={t(language, "participants")}
                      remotePartialCaption={null}
                      speakerNames={captionSpeakerNames}
                    />
                </aside>
                {conversationDisplayMode === "overlay" ? (
                  <aside ref={conversationOverlayRef} className="call-conversation-panel is-overlay is-draggable paper-supplemental-overlay" aria-label={t(language, "conversationModeOverlay")} style={{ transform: `translate3d(${conversationOverlayOffset.x}px, ${conversationOverlayOffset.y}px, 0)` }}>
                    <button type="button" aria-label={t(language, "conversation")} className="conversation-overlay-drag-handle" onPointerCancel={handleConversationOverlayDragEnd} onPointerDown={handleConversationOverlayDragStart} onPointerMove={handleConversationOverlayDragMove} onPointerUp={handleConversationOverlayDragEnd}><ChevronUp aria-hidden="true" /></button>
                    <ConversationPanel
                attachmentDraft={attachmentDraft}
                onAttach={attachChatFile}
                onRemoveAttachment={removeChatAttachment}
                fileError={fileError}
                downloads={downloads}
                onDownload={downloadChatFile}
                availableFileSenders={Object.keys(remoteParticipants)}
                chatMessages={chatMessages}
                localParticipantId={participantIdRef.current}
                draft={chatDraft}
                onDraftChange={setChatDraft}
                onSend={sendChatMessage}
                isSending={isChatSending}
                sendError={chatSendError}
                      controls={
                        <div className="paper-caption-controls">
                          <select aria-label={t(language, "changeLanguage")} value={language} onChange={(event) => { if (isSupportedLanguage(event.target.value)) handleLanguageSelect(event.target.value); }}>
                            {supportedLanguageOptions.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                          </select>
                          {captionServiceControl}
                        </div>
                      }
                      language={language}
                      localCaptionLog={localCaptionLog}
                      localName={displayName}
                      localPartialCaption={localPartialCaption}
                      remoteCaptionLog={remoteCaptionLog}
                      remoteName={t(language, "participants")}
                      remotePartialCaption={null}
                      speakerNames={captionSpeakerNames}
                    />
                  </aside>
                ) : null}
              </div>

              {activeControls}
            </>
          )}
        </section>
      </div>

      {fullscreenSurface && language ? (
        <section
          ref={fullscreenShellRef}
          className={`media-fullscreen-shell ${
            fullscreenSurfaceKind === "screen"
              ? "is-screen-share-fullscreen"
              : "is-participant-fullscreen"
          } is-conversation-${fullscreenConversationMode} ${
            isFullscreenBottomBarVisible
              ? "is-bottom-bar-visible"
              : "is-bottom-bar-hidden"
          }`}
          aria-label={t(language, "fullscreenSurface")}
        >
          <div className="media-fullscreen-stage">
            <VideoGrid
              language={language}
              layoutMode="focus"
              surfaces={orderedSurfaces}
              dominantSurfaceId={fullscreenSurface}
              onSelectSurface={handleOpenFullscreenSurfacePicker}
            />
            {fullscreenHasBottomBar ? (
              <button
                type="button"
                aria-expanded={isFullscreenBottomBarVisible}
                aria-label={
                  isFullscreenBottomBarVisible
                    ? t(language, "hideFullscreenBottomBar")
                    : t(language, "showFullscreenBottomBar")
                }
                onClick={() =>
                  setIsFullscreenBottomBarVisible((current) => !current)
                }
                className={`media-fullscreen-bottom-toggle ${
                  isFullscreenBottomBarVisible ? "is-open" : "is-closed"
                }`}
              >
                {isFullscreenBottomBarVisible ? (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                )}
                <span>
                  {isFullscreenBottomBarVisible
                    ? t(language, "hideFullscreenBottomBar")
                    : t(language, "showFullscreenBottomBar")}
                </span>
              </button>
            ) : null}
          </div>
          <div
            className={`media-fullscreen-topbar ${
              isFullscreenToolbarOpen ? "is-open" : "is-collapsed"
            }`}
          >
            <span className="mobile-fullscreen-title">{t(language, "fullscreenSurface")}</span>
            <button
              type="button"
              aria-expanded={isFullscreenToolbarOpen}
              aria-label={
                isFullscreenToolbarOpen
                  ? t(language, "hideFullscreenToolbar")
                  : t(language, "showFullscreenToolbar")
              }
              onClick={() => setIsFullscreenToolbarOpen((current) => !current)}
              className="media-fullscreen-toolbar-toggle"
            >
              {isFullscreenToolbarOpen ? (
                <PanelTopClose className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PanelTopOpen className="h-4 w-4" aria-hidden="true" />
              )}
              <span>
                {isFullscreenToolbarOpen
                  ? t(language, "hideFullscreenToolbar")
                  : t(language, "showFullscreenToolbar")}
              </span>
            </button>
            <div
              className="conversation-mode-menu-wrap media-fullscreen-conversation-menu"
              data-conversation-mode-menu-root
            >
              <button
                ref={fullscreenConversationModeButtonRef}
                type="button"
                aria-controls="conversation-mode-menu-fullscreen"
                aria-expanded={showConversationModeMenu}
                aria-haspopup="menu"
                aria-label={t(language, "openConversationModes")}
                onClick={() => handleConversationModeMenuToggle("fullscreen")}
                className={`media-fullscreen-control media-fullscreen-chat-button ${
                  (showConversationModeMenu &&
                    conversationModeMenuPlacement === "fullscreen") ||
                  conversationDisplayMode !== "hidden" ||
                  isCaptionPipOpen
                    ? "is-selected"
                    : ""
                }`}
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                <span>{t(language, "conversationControl")}</span>
              </button>
            </div>
            <div className="media-fullscreen-volume-wrap">
              <button
                ref={fullscreenVolumeButtonRef}
                type="button"
                aria-controls="participant-volume-mixer"
                aria-expanded={showVolumeMixer}
                aria-haspopup="dialog"
                aria-label={t(language, "participantAudio")}
                onClick={() => {
                  setShowConversationModeMenu(false);
                  setShowVolumeMixer((current) => !current);
                }}
                className={`media-fullscreen-control media-fullscreen-mixer-button ${
                  showVolumeMixer ? "is-selected" : ""
                }`}
              >
                <Volume2 className="h-4 w-4" aria-hidden="true" />
                <span>{t(language, "audioMixerControl")}</span>
              </button>
              {volumeMixer}
            </div>
            <div className="media-fullscreen-toolbar-panel">
                <button
                  type="button"
                  aria-label={t(language, "exitFullscreen")}
                  onClick={handleExitFullscreen}
                  className="media-fullscreen-control media-fullscreen-control-exit"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  <span>{t(language, "exitFullscreen")}</span>
                </button>
              </div>
          </div>
          {fullscreenConversationMode !== "hidden" ? (
            <aside
              ref={fullscreenConversationRef}
              className={`media-fullscreen-conversation ${
                fullscreenConversationMode === "overlay" ? "is-draggable" : ""
              }`}
              aria-label={t(language, "fullscreenConversation")}
              style={
                fullscreenConversationMode === "overlay"
                  ? {
                      transform: `translate3d(${fullscreenConversationOffset.x}px, ${fullscreenConversationOffset.y}px, 0)`,
                    }
                  : undefined
              }
            >
              {fullscreenConversationMode === "overlay" ? (
                <button
                  type="button"
                  aria-label={t(language, "fullscreenConversation")}
                  className="media-fullscreen-conversation-drag-handle"
                  onPointerCancel={handleFullscreenConversationDragEnd}
                  onPointerDown={handleFullscreenConversationDragStart}
                  onPointerMove={handleFullscreenConversationDragMove}
                  onPointerUp={handleFullscreenConversationDragEnd}
                >
                  <span aria-hidden="true" />
                </button>
              ) : null}
              <ConversationPanel
                attachmentDraft={attachmentDraft}
                onAttach={attachChatFile}
                onRemoveAttachment={removeChatAttachment}
                fileError={fileError}
                downloads={downloads}
                onDownload={downloadChatFile}
                availableFileSenders={Object.keys(remoteParticipants)}
                chatMessages={chatMessages}
                localParticipantId={participantIdRef.current}
                draft={chatDraft}
                onDraftChange={setChatDraft}
                onSend={sendChatMessage}
                isSending={isChatSending}
                sendError={chatSendError}
                language={language}
                localCaptionLog={localCaptionLog}
                localName={displayName}
                localPartialCaption={localPartialCaption}
                remoteCaptionLog={remoteCaptionLog}
                remoteName={t(language, "participants")}
                remotePartialCaption={null}
                speakerNames={captionSpeakerNames}
              />
            </aside>
          ) : null}
        </section>
      ) : null}

      <CallRoomModals
        isRoomHost={isRoomHost}
        audioOutputDevices={audioOutputDevices}
        callState={callState}
        canManageTurnRelay={canManageTurnRelay}
        connectionPathRows={connectionPathRows}
        connectionPathSummary={connectionPathSummary}
        isApplyingScreenQuality={isApplyingScreenQuality}
        isAudioOutputSelectionSupported={isAudioOutputSelectionSupported}
        isPreparingMedia={isPreparingMedia}
        isReplacingMicrophone={isReplacingMicrophone}
        isScreenSharing={isScreenSharing}
        isTestingMicrophone={isTestingMicrophone}
        language={language}
        localInputVolume={localInputVolume}
        masterOutputVolume={masterOutputVolume}
        mediaLayoutMode={mediaLayoutMode}
        microphoneDevices={microphoneDevices}
        microphoneLevel={microphoneLevel}
        onApplyScreenShareQuality={() => void handleApplyScreenShareQuality()}
        onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
        onCloseLayoutPicker={() => setShowLayoutPicker(false)}
        onCloseLeaveConfirmation={() => setShowLeaveConfirmation(false)}
        onCloseScreenShareSettings={closeScreenShareSettings}
        onCloseSettings={() => setShowSettings(false)}
        onCloseSurfacePicker={() => setSurfacePickerTarget(null)}
        onCloseVoiceSettings={closeVoiceSettings}
        onLanguageSelect={handleLanguageSelect}
        onLeaveCall={handleLeaveCall}
        onLocalInputVolumeChange={handleLocalInputVolumeChange}
        onMasterOutputVolumeChange={handleMasterOutputVolumeChange}
        onMediaLayoutModeChange={handleMediaLayoutModeChange}
        onMicrophoneDeviceChange={(deviceId) => {
          void handleMicrophoneDeviceChange(deviceId);
        }}
        onOpenVoiceSettings={openVoiceSettings}
        onRemoteVolumeChange={handleRemoteVolumeChange}
        onScreenShareAudioVolumeChange={handleScreenShareAudioVolumeChange}
        onScreenShareNumberChange={handleScreenShareNumberChange}
        onScreenShareResolutionChange={handleScreenShareResolutionChange}
        onSelectScreenSharePreset={handleSelectScreenSharePreset}
        onSelectSurface={handleSelectSurfaceForTarget}
        onStartMicrophoneTest={() => void startMicrophoneTest()}
        onStartScreenShareFromSettings={() => void handleStartScreenShareFromSettings()}
        onThemeChange={handleThemeChange}
        onUpdateScreenShareQuality={updateScreenShareQuality}
        onVoiceSettingCommit={handleVoiceSettingCommit}
        onVoiceSettingChange={handleVoiceSettingChange}
        orderedSurfaces={orderedSurfaces}
        remoteParticipants={remoteList}
        remoteVolumes={remoteVolumes}
        screenShareQuality={screenShareQuality}
        screenShareStats={screenShareStats}
        screenShareAudioVolume={screenShareAudioVolume}
        selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
        selectedMicrophoneDeviceId={selectedMicrophoneDeviceId}
        selectedScreenResolution={selectedScreenResolution}
        showLayoutPicker={showLayoutPicker}
        showLeaveConfirmation={showLeaveConfirmation}
        showScreenShareSettings={showScreenShareSettings}
        showSettings={showSettings}
        showVoiceSettings={showVoiceSettings}
        surfacePickerSelectedId={surfacePickerSelectedId}
        surfacePickerTarget={surfacePickerTarget}
        surfacePickerTitleKey={surfacePickerTitleKey}
        theme={theme}
        turnRelayReady={turnRelayReady}
        turnStatus={turnStatus}
        voiceSettings={displayedVoiceSettings}
      />

    </main>
  );
}
