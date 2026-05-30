"use client";

import {
  ArrowLeft,
  Camera,
  CameraOff,
  Captions,
  Copy,
  Flower2,
  LayoutGrid,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Settings,
  SlidersHorizontal,
  TowerControl,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LanguageGate } from "@/components/LanguageGate";
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
import { createEnhancedMicrophoneStream } from "@/lib/audioEnhancement";
import {
  clearSavedLanguage,
  getSavedDisplayName,
  getSavedLanguage,
  isSupportedLanguage,
  Language,
  saveDisplayName,
  saveLanguage,
  supportedLanguageOptions,
  t,
} from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import {
  getSavedParticipantSessionTokenForRoom,
  getSavedRoomCodeForRoom,
  saveParticipantSessionTokenForRoom,
} from "@/lib/roomCode";
import { getSocket } from "@/lib/socket";
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
  finalCaption: CaptionEvent | null;
  hasScreenShare: boolean;
  hasVideo: boolean;
  isSpeaking: boolean;
  partialCaption: CaptionEvent | null;
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
  screenSender: RTCRtpSender | null;
};

type StopScreenShareOptions = {
  emit?: boolean;
  renegotiate?: boolean;
};

type StopScreenShareFn = (options?: StopScreenShareOptions) => Promise<void>;

type ScreenSharePresetId =
  | "detail"
  | "balanced"
  | "motion"
  | "ultra"
  | "custom";
type ScreenShareOptimization = "detail" | "motion";
type ScreenShareQualitySettings = {
  presetId: ScreenSharePresetId;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
  optimization: ScreenShareOptimization;
  prioritizeScreen: boolean;
};
type ScreenShareConnectionPath = "direct" | "relay" | "unknown";
type ConnectionPathSummary = ScreenShareConnectionPath | "mixed";
type PeerConnectionPathSnapshot = {
  displayName: string;
  participantId: string;
  path: ScreenShareConnectionPath;
  roundTripMs?: number;
  updatedAt: number;
};
type ScreenShareStatsSnapshot = {
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  path: ScreenShareConnectionPath;
  roundTripMs?: number;
  limitation?: string;
};

const captionLogLimit = 80;
const mediaLayoutStorageKey = "sakura.mediaLayoutMode";
const mediaLayoutModes: MediaLayoutMode[] = [
  "gallery",
  "focus",
  "speaker",
  "collage",
  "compact",
];
const mediaLayoutModeTranslationKeys: Record<MediaLayoutMode, TranslationKey> = {
  gallery: "layoutGallery",
  focus: "layoutFocus",
  speaker: "layoutSpeaker",
  collage: "layoutCollage",
  compact: "layoutCompact",
};
const screenSharePresetIds: ScreenSharePresetId[] = [
  "detail",
  "balanced",
  "motion",
  "ultra",
  "custom",
];
const screenSharePresetDefaults: Record<
  Exclude<ScreenSharePresetId, "custom">,
  ScreenShareQualitySettings
> = {
  detail: {
    presetId: "detail",
    width: 1920,
    height: 1080,
    frameRate: 15,
    bitrateKbps: 4500,
    optimization: "detail",
    prioritizeScreen: true,
  },
  balanced: {
    presetId: "balanced",
    width: 1920,
    height: 1080,
    frameRate: 24,
    bitrateKbps: 6000,
    optimization: "detail",
    prioritizeScreen: true,
  },
  motion: {
    presetId: "motion",
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrateKbps: 8500,
    optimization: "motion",
    prioritizeScreen: true,
  },
  ultra: {
    presetId: "ultra",
    width: 3840,
    height: 2160,
    frameRate: 30,
    bitrateKbps: 18000,
    optimization: "detail",
    prioritizeScreen: true,
  },
};
const defaultScreenShareQuality = screenSharePresetDefaults.detail;
const screenShareResolutionOptions = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "4K", width: 3840, height: 2160 },
] as const;

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

function attachStreamToAudio(audio: HTMLAudioElement | null, stream: MediaStream | null) {
  if (!audio) {
    return;
  }

  if (audio.srcObject !== stream) {
    audio.srcObject = stream;
  }

  audio.muted = false;
  audio.volume = 1;

  if (stream) {
    void audio.play().catch(() => undefined);
  }
}

function turnStatusLabel(language: Language, status: TurnStatus | null) {
  switch (status?.phase) {
    case "disabled":
      return t(language, "turnRelayNotConfigured");
    case "ready":
      return t(language, "turnRelayReady");
    case "error":
      return t(language, "turnRelayError");
    default:
      return t(language, "turnRelayOff");
  }
}

function clampQualityNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function screenShareConstraints(
  settings: ScreenShareQualitySettings,
): MediaTrackConstraints {
  return {
    frameRate: {
      ideal: settings.frameRate,
      max: settings.frameRate,
    },
    height: { ideal: settings.height },
    width: { ideal: settings.width },
  };
}

function tuneSenderEncoding(
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

  return sender.setParameters(parameters).catch(() => undefined);
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

  stats.forEach((report) => {
    if (
      !selectedPair &&
      report.type === "candidate-pair" &&
      reportString(report, "state") === "succeeded" &&
      ((report as Record<string, unknown>).selected === true ||
        (report as Record<string, unknown>).nominated === true)
    ) {
      selectedPair = report;
    }
  });

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
    roundTripMs: roundTrip ? Math.round(roundTrip * 1000) : undefined,
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

function connectionPathLabel(language: Language, path: ConnectionPathSummary) {
  switch (path) {
    case "direct":
      return t(language, "connectionPathDirect");
    case "relay":
      return t(language, "connectionPathRelay");
    case "mixed":
      return t(language, "connectionPathMixed");
    case "unknown":
      return t(language, "connectionPathUnknown");
  }
}

function screenSharePresetLabel(language: Language, presetId: ScreenSharePresetId) {
  switch (presetId) {
    case "detail":
      return t(language, "screenQualityDetail");
    case "balanced":
      return t(language, "screenQualityBalanced");
    case "motion":
      return t(language, "screenQualityMotion");
    case "ultra":
      return t(language, "screenQualityUltra");
    case "custom":
      return t(language, "screenQualityCustom");
  }
}

function screenSharePresetHelp(language: Language, presetId: ScreenSharePresetId) {
  switch (presetId) {
    case "detail":
      return t(language, "screenQualityDetailHelp");
    case "balanced":
      return t(language, "screenQualityBalancedHelp");
    case "motion":
      return t(language, "screenQualityMotionHelp");
    case "ultra":
      return t(language, "screenQualityUltraHelp");
    case "custom":
      return t(language, "screenQualityCustomHelp");
  }
}

function createRemoteParticipant(participant: PublicParticipant): RemoteParticipantState {
  return {
    ...participant,
    audioStream: new MediaStream(),
    cameraStream: new MediaStream(),
    finalCaption: null,
    hasScreenShare: false,
    hasVideo: false,
    isSpeaking: false,
    partialCaption: null,
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
  const audioCaptureRef = useRef<AudioCaptureController | null>(null);
  const audioEnhancementStopRef = useRef<(() => void) | null>(null);
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
  const remoteVideoTrackStreamIdsRef = useRef<Map<string, Map<string, string>>>(
    new Map(),
  );
  const screenShareStatsSampleRef = useRef<{
    bytesSent: number;
    timestamp: number;
  } | null>(null);
  const stopScreenShareRef = useRef<StopScreenShareFn>(async () => undefined);

  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [isCodeCopied, setIsCodeCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showScreenShareSettings, setShowScreenShareSettings] = useState(false);
  const [showLayoutPicker, setShowLayoutPicker] = useState(false);
  const [isConversationVisible, setIsConversationVisible] = useState(true);
  const [surfacePickerTarget, setSurfacePickerTarget] =
    useState<SurfacePickerTarget | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [startWithCameraOff, setStartWithCameraOff] = useState(false);
  const [isPreparingMedia, setIsPreparingMedia] = useState(false);
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
  const [hasAcceptedCaptionProcessing, setHasAcceptedCaptionProcessing] =
    useState(false);
  const [localPartialCaption, setLocalPartialCaption] =
    useState<CaptionEvent | null>(null);
  const [localFinalCaption, setLocalFinalCaption] =
    useState<CaptionEvent | null>(null);
  const [localCaptionLog, setLocalCaptionLog] = useState<CaptionEvent[]>([]);
  const [remoteCaptionLog, setRemoteCaptionLog] = useState<CaptionEvent[]>([]);
  const [showSubtitleNotice, setShowSubtitleNotice] = useState(false);
  const [subtitleNoticeKey, setSubtitleNoticeKey] =
    useState<"subtitleServiceStartedNotice" | "subtitleServiceStoppedNotice" | "callHostLeftNotice">(
      "subtitleServiceStartedNotice",
    );
  const [subtitleNoticeId, setSubtitleNoticeId] = useState(0);
  const [turnStatus, setTurnStatus] = useState<TurnStatus | null>(null);

  const remoteParticipantsRef = useRef(remoteParticipants);

  useEffect(() => {
    remoteParticipantsRef.current = remoteParticipants;
  }, [remoteParticipants]);

  const remoteList = useMemo(
    () =>
      Object.values(remoteParticipants).sort(
        (first, second) => first.joinedAt - second.joinedAt,
      ),
    [remoteParticipants],
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
      );
    }
  }, []);

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

      closePeerConnection(peerState.peerConnection);
      peerConnectionsRef.current.delete(participantId);
      remoteVideoTrackStreamIdsRef.current.delete(participantId);
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
      await screenTrack
        .applyConstraints(screenShareConstraints(settings))
        .catch(() => undefined);

      await Promise.all(
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

      if (
        peerState.makingOffer ||
        peerState.peerConnection.signalingState !== "stable"
      ) {
        peerState.needsNegotiation = true;
        return;
      }

      await refreshIceServersForRoom(peerState.peerConnection).catch(() => false);
      peerState.makingOffer = true;
      peerState.needsNegotiation = false;

      try {
        const offer = await peerState.peerConnection.createOffer({
          iceRestart,
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await peerState.peerConnection.setLocalDescription(offer);
        socket.emit("webrtc:offer", {
          roomId,
          toParticipantId: participantId,
          description: peerState.peerConnection.localDescription,
        });
      } finally {
        peerState.makingOffer = false;

        if (
          peerState.needsNegotiation &&
          peerState.peerConnection.signalingState === "stable"
        ) {
          void createAndSendOffer(participantId, { iceRestart });
        }
      }
    },
    [refreshIceServersForRoom, roomId, socket],
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
        screenSender: null,
      };

      peerConnectionsRef.current.set(participantId, peerState);

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
          remoteVideoTrackStreamIdsRef.current.get(participantId) ?? new Map();
        remoteVideoTrackStreamIdsRef.current.set(participantId, trackStreamIds);

        if (event.track.kind === "video") {
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
        const isScreenTrack =
          event.track.kind === "video" &&
          Boolean(participant.screenStreamId) &&
          participant.screenStreamId === incomingStreamId;
        const targetStream =
          event.track.kind === "audio"
            ? participant.audioStream
            : isScreenTrack
              ? participant.screenStream
              : participant.cameraStream;

        if (!targetStream.getTracks().some((track) => track.id === event.track.id)) {
          targetStream.addTrack(event.track);
        }

        event.track.onended = () => {
          targetStream.removeTrack(event.track);
          trackStreamIds.delete(event.track.id);
          updateRemoteParticipant(participantId, (current) => ({
            ...current,
            hasScreenShare: current.screenStream
              .getVideoTracks()
              .some((track) => track.readyState === "live"),
            hasVideo: current.cameraStream
              .getVideoTracks()
              .some((track) => track.readyState === "live"),
          }));
        };

        if (
          event.track.kind === "audio" &&
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
          },
        }));
        setCallState("connected");
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;

        if (state === "connected") {
          setCallState("connected");
        } else if (state === "connecting") {
          setCallState("connecting");
        } else if (state === "disconnected") {
          setCallState("reconnecting");
        } else if (state === "failed" || state === "closed") {
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
      roomId,
      socket,
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

    if (!stream || !hasAcceptedCaptionProcessing) {
      return false;
    }

    audioCaptureRef.current = createAudioCapture({
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
    await audioCaptureRef.current.start();
    return true;
  }, [hasAcceptedCaptionProcessing, roomId, socket]);

  const beginLocalSubtitleCapture = useCallback(async () => {
    const started = await startLocalSubtitleCapture();

    if (!started) {
      setError(t(languageRef.current, "subtitleServiceUnavailable"));
    }

    return started;
  }, [startLocalSubtitleCapture]);

  const stopLocalMediaTracks = useCallback((stream: MediaStream | null) => {
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }

    audioEnhancementStopRef.current?.();
    audioEnhancementStopRef.current = null;
  }, []);

  const resetLocalMediaState = useCallback(() => {
    stopLocalSpeakingMonitor();
    stopLocalMediaTracks(localStreamRef.current);
    stopLocalMediaTracks(localScreenStreamRef.current);
    localStreamRef.current = null;
    localScreenStreamRef.current = null;
    screenShareStatsSampleRef.current = null;
    setIsMediaReady(false);
    setIsCameraEnabled(false);
    setIsScreenSharing(false);
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
    remoteVideoTrackStreamIdsRef.current.clear();
  }, [stopRemoteSpeakingMonitor]);

  const tearDownActiveCall = useCallback(() => {
    hasEndedCallRef.current = true;

    if (roomEndRedirectTimeoutRef.current !== null) {
      window.clearTimeout(roomEndRedirectTimeoutRef.current);
      roomEndRedirectTimeoutRef.current = null;
    }

    stopLocalSubtitleCapture();
    resetRemoteMediaState();
    resetLocalMediaState();
    closeAllPeerConnections();
    setDominantSurface(null);
    setFullscreenSurface(null);
    setCallState("disconnected");
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
    setLanguage(savedLanguage);
    setMediaLayoutMode(getSavedMediaLayoutMode());

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
    if (
      !showSettings &&
      !showLayoutPicker &&
      !showScreenShareSettings &&
      !surfacePickerTarget
    ) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowSettings(false);
        setShowLayoutPicker(false);
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
    showScreenShareSettings,
    showSettings,
    surfacePickerTarget,
  ]);

  useEffect(() => {
    if (!isScreenSharing) {
      screenShareStatsSampleRef.current = null;
      setScreenShareStats(null);
      return;
    }

    let isActive = true;

    async function updateScreenShareStats() {
      const screenTrack =
        localScreenStreamRef.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live") ?? null;

      if (!screenTrack) {
        return;
      }

      let selectedPeerConnection: RTCPeerConnection | null = null;
      let selectedSender: RTCRtpSender | null = null;

      for (const peerState of peerConnectionsRef.current.values()) {
        const sender =
          peerState.screenSender?.track?.id === screenTrack.id
            ? peerState.screenSender
            : findSenderForTrack(peerState.peerConnection, screenTrack);

        if (sender) {
          peerState.screenSender = sender;
          selectedPeerConnection = peerState.peerConnection;
          selectedSender = sender;
          break;
        }
      }

      if (!selectedPeerConnection || !selectedSender) {
        return;
      }

      const senderStats = await selectedSender.getStats().catch(() => null);
      const connectionStats = await selectedPeerConnection
        .getStats()
        .catch(() => null);

      if (!isActive || !senderStats) {
        return;
      }

      let outbound: RTCStats | null = null;
      senderStats.forEach((report) => {
        if (
          report.type === "outbound-rtp" &&
          (reportString(report, "kind") === "video" ||
            reportString(report, "mediaType") === "video")
        ) {
          outbound = report;
        }
      });

      if (!outbound) {
        return;
      }

      const bytesSent = reportNumber(outbound, "bytesSent");
      const timestamp = reportNumber(outbound, "timestamp");
      const previousSample = screenShareStatsSampleRef.current;
      const bitrateKbps =
        bytesSent !== undefined &&
        timestamp !== undefined &&
        previousSample &&
        timestamp > previousSample.timestamp
          ? Math.max(
              0,
              Math.round(
                ((bytesSent - previousSample.bytesSent) * 8) /
                  (timestamp - previousSample.timestamp),
              ),
            )
          : undefined;

      if (bytesSent !== undefined && timestamp !== undefined) {
        screenShareStatsSampleRef.current = { bytesSent, timestamp };
      }

      const connectionPath = connectionStats
        ? getSelectedConnectionPath(connectionStats)
        : { path: "unknown" as const };

      setScreenShareStats({
        bitrateKbps,
        fps: reportNumber(outbound, "framesPerSecond"),
        height: reportNumber(outbound, "frameHeight"),
        limitation: reportString(outbound, "qualityLimitationReason"),
        path: connectionPath.path,
        roundTripMs: connectionPath.roundTripMs,
        width: reportNumber(outbound, "frameWidth"),
      });
    }

    void updateScreenShareStats();
    const interval = window.setInterval(() => {
      void updateScreenShareStats();
    }, 2000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [isScreenSharing]);

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

      await refreshIceServersForRoom(peerState.peerConnection).catch(() => false);
      await peerState.peerConnection.setRemoteDescription(payload.description);
      await flushPendingIceCandidates(peerState);

      if (payload.description.type === "offer") {
        const answer = await peerState.peerConnection.createAnswer();
        await peerState.peerConnection.setLocalDescription(answer);
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

      setActiveScreenShareParticipantId(participantId);
      updateRemoteParticipant(participantId, (participant) => {
        const trackStreamIds =
          remoteVideoTrackStreamIdsRef.current.get(participantId) ?? new Map();

        for (const track of participant.cameraStream.getVideoTracks()) {
          if (trackStreamIds.get(track.id) === streamId) {
            participant.cameraStream.removeTrack(track);
            participant.screenStream.addTrack(track);
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
    }

    function handleRemoteScreenStopped(payload: { from?: string }) {
      const participantId = payload.from ?? "";

      if (!participantId) {
        return;
      }

      setActiveScreenShareParticipantId((current) =>
        current === participantId ? "" : current,
      );
      updateRemoteParticipant(participantId, (participant) => {
        for (const track of participant.screenStream.getTracks()) {
          participant.screenStream.removeTrack(track);
        }

        return {
          ...participant,
          hasScreenShare: false,
          screenStreamId: "",
        };
      });
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

    function handleCaption(caption: CaptionEvent) {
      setRemoteCaptionLog((log) =>
        caption.isFinal ? appendCaptionLog(log, caption) : log,
      );
      updateRemoteParticipant(caption.speakerId, (participant) => ({
        ...participant,
        finalCaption: caption.isFinal ? caption : participant.finalCaption,
        partialCaption: caption.isFinal ? null : caption,
      }));
    }

    function handleCaptionPreview(caption: CaptionEvent) {
      if (caption.isFinal) {
        setLocalFinalCaption(caption);
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

      if (hasAcceptedCaptionProcessing) {
        await beginLocalSubtitleCapture();
      }
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
      setCameraError(t(languageRef.current, "screenShareAlreadyActive"));
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
          if (response.subtitleServiceStarted && hasAcceptedCaptionProcessing) {
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
    ensurePeerConnection,
    flushPendingIceCandidates,
    hasAcceptedCaptionProcessing,
    refreshIceServersForRoom,
    rememberParticipantSessionToken,
    removeRemotePeer,
    remoteList.length,
    roomId,
    router,
    showSubtitleServiceBanner,
    socket,
    stopLocalSubtitleCapture,
    tearDownActiveCall,
    updateRemoteParticipant,
    upsertRemoteParticipant,
  ]);

  useEffect(() => {
    return () => {
      const shouldNotifyLeave = socket.connected && !hasEndedCallRef.current;
      const participantId = participantIdRef.current;

      tearDownActiveCall();

      if (shouldNotifyLeave) {
        socket.emit("room:leave", {
          roomId,
          participantId,
        });
      }
    };
  }, [roomId, socket, tearDownActiveCall]);

  const requestCameraTrack = useCallback(async () => {
    const videoStream = await navigator.mediaDevices.getUserMedia({
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

    let audioStream: MediaStream;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (mediaError) {
      throw new Error(
        mediaError instanceof DOMException &&
          mediaError.name === "NotAllowedError"
          ? "microphone-denied"
          : "microphone-unavailable",
      );
    }

    const enhancedMicrophone = await createEnhancedMicrophoneStream(audioStream);
    audioEnhancementStopRef.current = enhancedMicrophone.stop;
    const combinedStream = new MediaStream(enhancedMicrophone.stream.getAudioTracks());

    for (const track of combinedStream.getAudioTracks()) {
      track.enabled = !isMuted;
    }

    if (startWithCameraOff) {
      setIsCameraEnabled(false);
      setCameraError("");
    } else {
      try {
        combinedStream.addTrack(await requestCameraTrack());
        setIsCameraEnabled(true);
        setCameraError("");
      } catch (mediaError) {
        setIsCameraEnabled(false);
        setCameraError(
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
    requestCameraTrack,
    resetLocalMediaState,
    startLocalSpeakingMonitor,
    startWithCameraOff,
  ]);

  async function handlePrepareMedia() {
    setError("");
    setCameraError("");
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

  async function handleJoinCall(preparedStream?: MediaStream) {
    playRemoteAudio();

    if (!language || !roomInfo) {
      return;
    }

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
        setActiveScreenShareParticipantId(response.activeScreenShareParticipantId ?? "");
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

        if (response.subtitleServiceStarted && hasAcceptedCaptionProcessing) {
          await beginLocalSubtitleCapture();
        }
      },
    );
  }

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

    handleLeaveCall();
  }

  async function handleCopyCode() {
    if (!roomInfo?.roomCode) {
      return;
    }

    await navigator.clipboard.writeText(roomInfo.roomCode);
    setIsCodeCopied(true);
    window.setTimeout(() => setIsCodeCopied(false), 1600);
  }

  function handleToggleMute() {
    playRemoteAudio();

    const nextMuted = !isMuted;
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }
    setIsMuted(nextMuted);
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
        setCameraError(t(languageRef.current, "cameraUnavailable"));
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
      setCameraError("");
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
      setCameraError(
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
    screenShareStatsSampleRef.current = null;
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
      setCameraError(t(languageRef.current, "screenShareAlreadyActive"));
      return false;
    }

    if (
      !isScreenShareSupported ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      setCameraError(t(languageRef.current, "screenShareUnavailable"));
      return false;
    }

    return true;
  }

  async function startScreenShare(settings: ScreenShareQualitySettings) {
    if (!canStartScreenShare()) {
      return false;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: screenShareConstraints(settings),
      });
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

      const screenSenders: Array<RTCRtpSender | null> = [];

      for (const peerState of peerConnectionsRef.current.values()) {
        peerState.screenSender = peerState.peerConnection.addTrack(
          screenTrack,
          screenStream,
        );
        screenSenders.push(peerState.screenSender);
      }

      await applyScreenShareQualityToTrack(settings, screenTrack, screenSenders);

      socket.emit("media:screen-started", {
        roomId,
        from: participantIdRef.current,
        streamId: screenStream.id,
      });

      screenShareStatsSampleRef.current = null;
      setIsScreenSharing(true);
      setActiveScreenShareQuality(settings);
      setActiveScreenShareParticipantId(participantIdRef.current);
      setDominantSurface(screenSurfaceId(participantIdRef.current));
      setCameraError("");
      setScreenShareStats(null);

      if (callState !== "idle") {
        await createOffersForAllPeers();
      }

      return true;
    } catch (mediaError) {
      if (
        mediaError instanceof DOMException &&
        mediaError.name === "NotAllowedError"
      ) {
        return false;
      }

      setCameraError(t(languageRef.current, "screenShareUnavailable"));
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
      screenShareStatsSampleRef.current = null;
      setActiveScreenShareQuality(screenShareQuality);
      setShowScreenShareSettings(false);
    } finally {
      setIsApplyingScreenQuality(false);
    }
  }

  function requestSubtitleServiceStart({ captureAfterStart = hasAcceptedCaptionProcessing } = {}) {
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

        if (captureAfterStart) {
          await beginLocalSubtitleCapture();
        }
      },
    );
  }

  function handleToggleSubtitleService() {
    playRemoteAudio();

    if (!hasAcceptedCaptionProcessing) {
      setHasAcceptedCaptionProcessing(true);

      if (isSubtitleServiceStarted || !isRoomHost) {
        void beginLocalSubtitleCapture();
        return;
      }
    }

    if (isStartingSubtitleService) {
      return;
    }

    if (!isRoomHost) {
      if (isSubtitleServiceStarted) {
        void beginLocalSubtitleCapture();
      }
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

    requestSubtitleServiceStart({ captureAfterStart: true });
  }

  function handleLeaveCall() {
    const participantId = participantIdRef.current;

    tearDownActiveCall();

    if (socket.connected) {
      socket.emit("room:leave", {
        roomId,
        participantId,
      });
    }

    router.push("/");
  }

  function handleEnterFullscreen(surfaceId: MediaSurfaceId) {
    setFullscreenSurface(surfaceId);
    setDominantSurface(surfaceId);

    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }

  function handleExitFullscreen() {
    setFullscreenSurface(null);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  function handleOpenSurfacePicker(
    surfaceId: MediaSurfaceId,
    slot: MediaSurfacePlacement,
    scope: SurfacePickerTarget["scope"] = "call",
  ) {
    setSurfacePickerTarget({ scope, slot, surfaceId });
  }

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

  const surfaces: MediaSurface[] = (() => {
    const localId = participantIdRef.current || "local";
    const localVideoStream =
      localStreamRef.current && hasLiveVideoTrack(localStreamRef.current)
        ? localStreamRef.current
        : null;
    const localHasVideo = Boolean(localVideoStream);
    const nextSurfaces: MediaSurface[] = [
      {
        hasVideo: localHasVideo,
        id: participantSurfaceId(localId),
        isLocal: true,
        isSpeaking: isLocalSpeaking,
        kind: "participant",
        label: displayName || t(language ?? "en", "localVideo"),
        status: isMuted ? t(language ?? "en", "muted") : "",
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
        status: participantHasVideo ? "" : t(language ?? "en", "audioOnly"),
        stream: participant.cameraStream,
      });
    }

    return nextSurfaces;
  })();
  const orderedSurfaces = orderMediaSurfaces(surfaces, surfaceOrder);
  const fullscreenSurfaceKind = fullscreenSurface
    ? orderedSurfaces.find((surface) => surface.id === fullscreenSurface)?.kind ?? null
    : null;
  const surfacePickerSelectedId = surfacePickerTarget?.surfaceId ?? null;
  const surfacePickerTitleKey =
    surfacePickerTarget?.slot === "dominant"
      ? "chooseDominantView"
      : "chooseSmallView";

  const captionSpeakerNames = useMemo(() => {
    const names: Record<string, string> = {
      [participantIdRef.current]: displayName || t(language ?? "en", "localVideo"),
    };

    for (const participant of remoteList) {
      names[participant.participantId] = participant.displayName;
    }

    return names;
  }, [displayName, language, remoteList]);

  const activeControls = callState !== "idle" && language ? (
    <section
      aria-label={t(language, "callControls")}
      className="call-control-bar garden-panel"
    >
      <button
        type="button"
        aria-label={isMuted ? t(language, "unmute") : t(language, "mute")}
        onClick={handleToggleMute}
        className={`call-control-button ${isMuted ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </span>
        <span className="call-control-label">{t(language, "micControl")}</span>
      </button>

      {isRoomHost || (isSubtitleServiceStarted && !hasAcceptedCaptionProcessing) ? (
        <button
          type="button"
          aria-label={
            !hasAcceptedCaptionProcessing
              ? t(language, "captionPrivacyConfirm")
              : isSubtitleServiceStarted
                ? t(language, "stopSubtitleService")
                : t(language, "startSubtitleService")
          }
          onClick={handleToggleSubtitleService}
          disabled={isStartingSubtitleService}
          className={`call-control-button call-control-captions ${
            isSubtitleServiceStarted ? "is-active" : ""
          }`}
        >
          <span className="call-control-icon" aria-hidden="true">
            <Captions className="h-5 w-5" />
          </span>
          <span className="call-control-label">
            {isStartingSubtitleService
              ? t(language, "startingControl")
              : t(language, "captionsControl")}
          </span>
        </button>
      ) : null}

      <button
        type="button"
        aria-label={isCameraEnabled ? t(language, "cameraOff") : t(language, "cameraOn")}
        onClick={handleToggleCamera}
        className={`call-control-button ${isCameraEnabled ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          {isCameraEnabled ? (
            <Camera className="h-5 w-5" />
          ) : (
            <CameraOff className="h-5 w-5" />
          )}
        </span>
        <span className="call-control-label">{t(language, "cameraControl")}</span>
      </button>

      <button
        type="button"
        aria-label={
          !isScreenShareSupported
            ? t(language, "screenShareUnavailable")
            : isScreenSharing
              ? t(language, "screenShareOn")
              : t(language, "screenShareOff")
        }
        onClick={() => void handleToggleScreenShare()}
        disabled={
          !isScreenShareSupported ||
          Boolean(
            activeScreenShareParticipantId &&
              activeScreenShareParticipantId !== participantIdRef.current,
          )
        }
        className={`call-control-button ${isScreenSharing ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          {isScreenSharing ? (
            <ScreenShareOff className="h-5 w-5" />
          ) : (
            <ScreenShare className="h-5 w-5" />
          )}
        </span>
        <span className="call-control-label">{t(language, "shareControl")}</span>
      </button>

      {isScreenSharing ? (
        <button
          type="button"
          aria-label={t(language, "openScreenQuality")}
          onClick={openScreenShareSettings}
          className={`call-control-button ${
            showScreenShareSettings ? "is-active" : ""
          }`}
        >
          <span className="call-control-icon" aria-hidden="true">
            <SlidersHorizontal className="h-5 w-5" />
          </span>
          <span className="call-control-label">{t(language, "qualityControl")}</span>
        </button>
      ) : null}

      <button
        type="button"
        aria-label={t(language, "viewLayout")}
        onClick={() => setShowLayoutPicker(true)}
        className={`call-control-button ${showLayoutPicker ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          <LayoutGrid className="h-5 w-5" />
        </span>
        <span className="call-control-label">{t(language, "viewControl")}</span>
      </button>

      <button
        type="button"
        aria-label={
          isConversationVisible
            ? t(language, "hideConversation")
            : t(language, "showConversation")
        }
        aria-pressed={isConversationVisible}
        onClick={() => setIsConversationVisible((current) => !current)}
        className={`call-control-button ${isConversationVisible ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          <MessageSquare className="h-5 w-5" />
        </span>
        <span className="call-control-label">
          {t(language, "conversationControl")}
        </span>
      </button>

      <button
        type="button"
        aria-label={t(language, "leaveCall")}
        onClick={handleLeaveCall}
        className="call-control-button call-control-leave"
      >
        <span className="call-control-icon" aria-hidden="true">
          <PhoneOff className="h-5 w-5" />
        </span>
        <span className="call-control-label">{t(language, "leaveControl")}</span>
      </button>
    </section>
  ) : null;

  const connectionPathRows = remoteList.map((participant) => {
    return (
      connectionPathSnapshots[participant.participantId] ?? {
        displayName: participant.displayName,
        participantId: participant.participantId,
        path: "unknown" as const,
        updatedAt: 0,
      }
    );
  });
  const connectionPathSummary = summarizeConnectionPath(
    connectionPathRows,
    remoteList.length,
  );

  const connectionPathPanel = language ? (
    <section className="settings-modal-section connection-path-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <TowerControl className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="garden-text-ink text-base font-black">
              {t(language, "connectionPathTitle")}
            </h2>
            <span className={`connection-path-pill is-${connectionPathSummary}`}>
              {connectionPathLabel(language, connectionPathSummary)}
            </span>
          </div>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {t(language, "connectionPathHelp")}
          </p>

          <div className="connection-path-list">
            {connectionPathRows.length > 0 ? (
              connectionPathRows.map((snapshot) => (
                <div
                  className="connection-path-row"
                  key={snapshot.participantId}
                >
                  <span className="connection-path-peer">
                    {snapshot.displayName}
                  </span>
                  <span className={`connection-path-pill is-${snapshot.path}`}>
                    {connectionPathLabel(language, snapshot.path)}
                  </span>
                  {snapshot.roundTripMs !== undefined ? (
                    <span className="connection-path-rtt">
                      {t(language, "connectionPathRoundTrip")}{" "}
                      {snapshot.roundTripMs} ms
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="connection-path-empty">
                {t(language, "connectionPathNoPeers")}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  ) : null;

  const turnRelayPanel = canManageTurnRelay && language ? (
    <section className="settings-modal-section turn-relay-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <TowerControl className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="garden-text-ink text-base font-black">
              {t(language, "turnRelayTitle")}
            </h2>
            <span
              className={`turn-relay-pill ${
                turnRelayReady ? "is-ready" : turnStatus?.phase === "error" ? "is-error" : ""
              }`}
            >
              {turnStatusLabel(language, turnStatus)}
            </span>
          </div>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {turnRelayReady
              ? t(language, "turnRelayReadyHelp")
              : t(language, "turnRelayHelp")}
          </p>
          {turnStatus?.provider ? (
            <p className="garden-muted mt-2 truncate text-xs font-black">
              {turnStatus.provider}
            </p>
          ) : null}
          {turnStatus?.host ? (
            <p className="garden-muted mt-1 truncate text-xs font-black">
              {turnStatus.host}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  ) : null;

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
      className={`sakura-home call-room-scene garden-scene safe-bottom min-h-dvh px-4 py-4 sm:px-6 lg:px-8 ${
        callState === "idle" ? "" : "call-scene-active"
      } ${
        callState !== "idle" && !isConversationVisible
          ? "is-conversation-hidden"
          : ""
      }`}
    >
      {remoteList.map((participant) => (
        <audio
          key={participant.participantId}
          data-participant-id={participant.participantId}
          ref={(element) => attachStreamToAudio(element, participant.audioStream)}
          autoPlay
          playsInline
        />
      ))}

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
              <p className="call-topbar-kicker garden-kicker flex items-center gap-2">
                <Flower2
                  className="garden-icon-blush h-4 w-4"
                  aria-hidden="true"
                />
                {t(language, "appName")}
              </p>
              <p
                className={`call-topbar-title garden-title mt-2 ${
                  callState === "idle"
                    ? "text-2xl sm:text-3xl"
                    : "text-xl sm:text-2xl"
                }`}
              >
                {callState !== "idle" ? (
                  <span className="call-topbar-status-dot" aria-hidden="true" />
                ) : null}
                {statusText}
              </p>
              <p className="garden-muted mt-1 text-sm font-black">
                {t(language, "participants")}: {participantCount} / {maxParticipants}
              </p>
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
              <section className="garden-panel p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
                    <Mic className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="garden-text-ink text-lg font-black">
                      {t(language, "permissionsTitle")}
                    </h2>
                    <p className="garden-muted mt-1 text-sm font-bold leading-snug">
                      {isMediaReady
                        ? t(language, "permissionsReady")
                        : t(language, "permissionsHelp")}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handlePrepareMedia}
                  disabled={isPreparingMedia}
                  className={`garden-button setup-state-button mt-4 h-14 w-full gap-2 px-5 text-base ${
                    isMediaReady ? "is-on" : "is-off"
                  }`}
                >
                  <Mic className="h-5 w-5" aria-hidden="true" />
                  <span>
                    {isPreparingMedia
                      ? t(language, "preparingPermissions")
                      : isMediaReady
                        ? t(language, "permissionsReady")
                        : t(language, "allowPermissions")}
                  </span>
                </button>

                {isMediaReady ? (
                  <div className="setup-preview mt-4">
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
                  </div>
                ) : null}

                <div className="setup-start-options mt-4 grid gap-3">
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
                        !startWithCameraOff || isCameraEnabled ? "is-on" : "is-off"
                      }`}
                    >
                      {!startWithCameraOff || isCameraEnabled ? (
                        <Camera className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <CameraOff className="h-5 w-5" aria-hidden="true" />
                      )}
                      {!startWithCameraOff || isCameraEnabled
                        ? t(language, "startCameraOn")
                        : t(language, "startCameraOff")}
                    </button>
                  </div>
                </div>

                {isMediaReady ? (
                  <button
                    type="button"
                    disabled={!roomInfo || !hasLiveAudioTrack(localStreamRef.current)}
                    onClick={() => void handleJoinCall()}
                    className="garden-button garden-button-primary setup-join-button mt-4 h-16 w-full px-5 text-xl"
                  >
                    {t(language, "joinCall")}
                  </button>
                ) : null}
              </section>

              {error || cameraError ? (
                <div className="grid gap-2">
                  {error ? (
                    <p className="garden-alert-error rounded-lg px-4 py-3 text-sm font-black">
                      {error}
                    </p>
                  ) : null}
                  {cameraError ? (
                    <p className="garden-alert-warning rounded-lg px-4 py-3 text-sm font-black">
                      {cameraError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div
                className={`active-call-workspace ${
                  isConversationVisible ? "" : "is-conversation-hidden"
                }`}
              >
                <div className="active-media-column">
                  {fullscreenSurface ? null : (
                    <VideoGrid
                      language={language}
                      layoutMode={mediaLayoutMode}
                      surfaces={orderedSurfaces}
                      dominantSurfaceId={dominantSurface}
                      onFullscreenSurface={handleEnterFullscreen}
                      onSelectSurface={(surfaceId, slot) =>
                        handleOpenSurfacePicker(surfaceId, slot)
                      }
                    />
                  )}

                  {error || cameraError ? (
                    <div className="grid gap-2">
                      {error ? (
                        <p className="garden-alert-error rounded-lg px-4 py-3 text-sm font-black">
                          {error}
                        </p>
                      ) : null}
                      {cameraError ? (
                        <p className="garden-alert-warning rounded-lg px-4 py-3 text-sm font-black">
                          {cameraError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {isConversationVisible ? (
                  <ConversationPanel
                    language={language}
                    localCaptionLog={localCaptionLog}
                    localFinalCaption={localFinalCaption}
                    localName={displayName}
                    localPartialCaption={localPartialCaption}
                    remoteCaptionLog={remoteCaptionLog}
                    remoteFinalCaption={null}
                    remoteName={t(language, "participants")}
                    remotePartialCaption={null}
                    speakerNames={captionSpeakerNames}
                  />
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
          }`}
          aria-label={t(language, "fullscreenSurface")}
        >
          <div className="media-fullscreen-stage">
            <VideoGrid
              language={language}
              layoutMode="focus"
              surfaces={orderedSurfaces}
              dominantSurfaceId={fullscreenSurface}
              onSelectSurface={(surfaceId, slot) =>
                handleOpenSurfacePicker(surfaceId, slot, "fullscreen")
              }
            />
          </div>
          <div className="media-fullscreen-topbar">
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
          <aside
            className="media-fullscreen-conversation"
            aria-label={t(language, "fullscreenConversation")}
          >
            <ConversationPanel
              language={language}
              localCaptionLog={localCaptionLog}
              localFinalCaption={localFinalCaption}
              localName={displayName}
              localPartialCaption={localPartialCaption}
              remoteCaptionLog={remoteCaptionLog}
              remoteFinalCaption={null}
              remoteName={t(language, "participants")}
              remotePartialCaption={null}
              speakerNames={captionSpeakerNames}
            />
          </aside>
        </section>
      ) : null}

      {surfacePickerTarget && language ? (
        <div
          className="settings-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={() => setSurfacePickerTarget(null)}
        >
          <section
            aria-labelledby="surface-picker-modal-title"
            aria-modal="true"
            className="settings-modal surface-picker-modal max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-ribbon" aria-hidden="true" />
            <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <LayoutGrid
                    className="garden-icon-blush h-4 w-4"
                    aria-hidden="true"
                  />
                  {t(language, "viewControl")}
                </p>
                <h2
                  className="garden-title mt-2 text-2xl"
                  id="surface-picker-modal-title"
                >
                  {t(language, surfacePickerTitleKey)}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeLayoutPicker")}
                onClick={() => setSurfacePickerTarget(null)}
                className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="surface-picker-options grid gap-3 px-5 pb-5">
              {orderedSurfaces.map((surface) => {
                const Icon = surface.kind === "screen" ? ScreenShare : Camera;
                const isCurrentSurface = surface.id === surfacePickerSelectedId;
                const surfaceStatus =
                  surface.status ||
                  t(
                    language,
                    surface.kind === "screen" ? "shareControl" : "cameraControl",
                  );

                return (
                  <button
                    key={surface.id}
                    type="button"
                    onClick={() => handleSelectSurfaceForTarget(surface.id)}
                    className={`view-layout-option surface-picker-option ${
                      isCurrentSurface ? "is-selected" : ""
                    }`}
                  >
                    <span
                      className={`surface-picker-preview is-${surface.kind}`}
                      aria-hidden="true"
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="view-layout-option-copy surface-picker-option-copy">
                      <span>{surface.label}</span>
                      <small>
                        {isCurrentSurface
                          ? t(language, "selected")
                          : surfaceStatus}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {showLayoutPicker && language ? (
        <div
          className="settings-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={() => setShowLayoutPicker(false)}
        >
          <section
            aria-labelledby="view-layout-modal-title"
            aria-modal="true"
            className="settings-modal view-layout-modal max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-ribbon" aria-hidden="true" />
            <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <LayoutGrid
                    className="garden-icon-blush h-4 w-4"
                    aria-hidden="true"
                  />
                  {t(language, "viewControl")}
                </p>
                <h2
                  className="garden-title mt-2 text-2xl"
                  id="view-layout-modal-title"
                >
                  {t(language, "viewLayout")}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeSettings")}
                onClick={() => setShowLayoutPicker(false)}
                className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="view-layout-options grid gap-3 px-5 pb-5">
              {mediaLayoutModes.map((mode) => {
                const isSelected = mode === mediaLayoutMode;

                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleMediaLayoutModeChange(mode)}
                    className={`view-layout-option ${
                      isSelected ? "is-selected" : ""
                    }`}
                  >
                    <span className={`view-layout-preview is-${mode}`} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="view-layout-option-copy">
                      <span>{t(language, mediaLayoutModeTranslationKeys[mode])}</span>
                      {isSelected ? <small>{t(language, "selected")}</small> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {showSettings ? (
        <div
          className="settings-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={() => setShowSettings(false)}
        >
          <section
            aria-labelledby="call-settings-modal-title"
            aria-modal="true"
            className="settings-modal max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-ribbon" aria-hidden="true" />
            <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <Flower2
                    className="garden-icon-blush h-4 w-4"
                    aria-hidden="true"
                  />
                  {t(language, "appName")}
                </p>
                <h2
                  className="garden-title mt-2 text-2xl"
                  id="call-settings-modal-title"
                >
                  {t(language, "settings")}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeSettings")}
                onClick={() => setShowSettings(false)}
                className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="settings-modal-content grid gap-4 px-5 pb-5">
              {hostRoomCode ? (
                <section className="settings-modal-section settings-room-code-section">
                  <div className="flex items-start gap-3">
                    <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
                      <Copy className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="garden-text-muted text-sm font-black">
                        {t(language, "roomCode")}
                      </p>
                      <button
                        type="button"
                        aria-label={
                          isCodeCopied
                            ? t(language, "copied")
                            : t(language, "copyRoomCode")
                        }
                        onClick={handleCopyCode}
                        className="garden-button garden-button-quiet settings-room-code-button mt-3 h-14 w-full gap-2 px-4 text-2xl"
                      >
                        <Copy className="h-5 w-5 shrink-0" aria-hidden="true" />
                        <span className="font-black">{hostRoomCode}</span>
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="settings-modal-section">
                <p className="garden-text-muted text-sm font-black">
                  {t(language, "changeLanguage")}
                </p>
                <select
                  value={language}
                  onChange={(event) => {
                    const nextLanguage = event.target.value;

                    if (isSupportedLanguage(nextLanguage)) {
                      handleLanguageSelect(nextLanguage);
                    }
                  }}
                  className="garden-select settings-language-select"
                >
                  {supportedLanguageOptions.map(({ code, label }) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </section>

              <section className="settings-modal-section">
                <p className="garden-text-muted text-sm font-black">
                  {t(language, "captionPrivacyTitle")}
                </p>
                <p className="garden-muted mt-2 text-sm font-bold leading-snug">
                  {t(language, "captionPrivacyBody")}
                </p>
              </section>

              {connectionPathPanel}
              {turnRelayPanel}
            </div>
          </section>
        </div>
      ) : null}

      {showScreenShareSettings && language ? (
        <div
          className="screen-quality-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={closeScreenShareSettings}
        >
          <section
            aria-labelledby="screen-quality-modal-title"
            aria-modal="true"
            className="screen-quality-modal w-full max-w-2xl overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="screen-quality-modal-header">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                  {t(language, "screenQualityKicker")}
                </p>
                <h2
                  id="screen-quality-modal-title"
                  className="garden-title mt-1 text-2xl"
                >
                  {isScreenSharing
                    ? t(language, "screenQualityLiveTitle")
                    : t(language, "screenQualityTitle")}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeScreenQuality")}
                onClick={closeScreenShareSettings}
                className="garden-icon-button grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="screen-quality-content">
              <p className="screen-quality-help">
                {isScreenSharing
                  ? t(language, "screenQualityLiveHelp")
                  : t(language, "screenQualityHelp")}
              </p>

              <section className="screen-quality-section">
                <h3>{t(language, "screenQualityPreset")}</h3>
                <div className="screen-quality-presets">
                  {screenSharePresetIds.map((presetId) => (
                    <button
                      key={presetId}
                      type="button"
                      onClick={() => handleSelectScreenSharePreset(presetId)}
                      className={`screen-quality-preset ${
                        screenShareQuality.presetId === presetId
                          ? "is-selected"
                          : ""
                      }`}
                    >
                      <span>{screenSharePresetLabel(language, presetId)}</span>
                      <small>{screenSharePresetHelp(language, presetId)}</small>
                    </button>
                  ))}
                </div>
              </section>

              <section className="screen-quality-section">
                <h3>{t(language, "screenQualityManual")}</h3>
                <div className="screen-quality-fields">
                  <label className="screen-quality-field">
                    <span>{t(language, "screenQualityResolution")}</span>
                    <select
                      value={selectedScreenResolution}
                      onChange={(event) =>
                        handleScreenShareResolutionChange(event.target.value)
                      }
                      className="screen-quality-input"
                    >
                      {screenShareResolutionOptions.map((option) => (
                        <option
                          key={`${option.width}x${option.height}`}
                          value={`${option.width}x${option.height}`}
                        >
                          {option.label} ({option.width}x{option.height})
                        </option>
                      ))}
                      <option value="custom">
                        {t(language, "screenQualityCustom")}
                      </option>
                    </select>
                  </label>

                  <label className="screen-quality-field">
                    <span>{t(language, "screenQualityWidth")}</span>
                    <input
                      type="number"
                      min={640}
                      max={3840}
                      step={160}
                      value={screenShareQuality.width}
                      onChange={(event) =>
                        handleScreenShareNumberChange("width", event.target.value)
                      }
                      className="screen-quality-input"
                    />
                  </label>

                  <label className="screen-quality-field">
                    <span>{t(language, "screenQualityHeight")}</span>
                    <input
                      type="number"
                      min={360}
                      max={2160}
                      step={90}
                      value={screenShareQuality.height}
                      onChange={(event) =>
                        handleScreenShareNumberChange("height", event.target.value)
                      }
                      className="screen-quality-input"
                    />
                  </label>

                  <label className="screen-quality-field">
                    <span>{t(language, "screenQualityFrameRate")}</span>
                    <input
                      type="number"
                      min={5}
                      max={60}
                      step={1}
                      value={screenShareQuality.frameRate}
                      onChange={(event) =>
                        handleScreenShareNumberChange(
                          "frameRate",
                          event.target.value,
                        )
                      }
                      className="screen-quality-input"
                    />
                  </label>

                  <label className="screen-quality-field">
                    <span>{t(language, "screenQualityBitrate")}</span>
                    <input
                      type="number"
                      min={500}
                      max={30000}
                      step={500}
                      value={screenShareQuality.bitrateKbps}
                      onChange={(event) =>
                        handleScreenShareNumberChange(
                          "bitrateKbps",
                          event.target.value,
                        )
                      }
                      className="screen-quality-input"
                    />
                  </label>
                </div>
              </section>

              <section className="screen-quality-section">
                <h3>{t(language, "screenQualityOptimizeFor")}</h3>
                <div className="screen-quality-segment">
                  <button
                    type="button"
                    onClick={() =>
                      updateScreenShareQuality({ optimization: "detail" })
                    }
                    className={
                      screenShareQuality.optimization === "detail"
                        ? "is-selected"
                        : ""
                    }
                  >
                    {t(language, "screenQualityOptimizeDetail")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateScreenShareQuality({ optimization: "motion" })
                    }
                    className={
                      screenShareQuality.optimization === "motion"
                        ? "is-selected"
                        : ""
                    }
                  >
                    {t(language, "screenQualityOptimizeMotion")}
                  </button>
                </div>

                <label className="screen-quality-toggle">
                  <input
                    type="checkbox"
                    checked={screenShareQuality.prioritizeScreen}
                    onChange={(event) =>
                      updateScreenShareQuality({
                        prioritizeScreen: event.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>{t(language, "screenQualityPrioritizeScreen")}</strong>
                    <small>
                      {t(language, "screenQualityPrioritizeScreenHelp")}
                    </small>
                  </span>
                </label>
              </section>

              {isScreenSharing ? (
                <section className="screen-quality-section screen-quality-stats">
                  <h3>{t(language, "screenQualityActual")}</h3>
                  {screenShareStats ? (
                    <dl>
                      <div>
                        <dt>{t(language, "screenQualityResolution")}</dt>
                        <dd>
                          {screenShareStats.width && screenShareStats.height
                            ? `${screenShareStats.width}x${screenShareStats.height}`
                            : "-"}
                        </dd>
                      </div>
                      <div>
                        <dt>{t(language, "screenQualityFrameRate")}</dt>
                        <dd>
                          {screenShareStats.fps
                            ? `${Math.round(screenShareStats.fps)} ${t(
                                language,
                                "screenQualityFpsUnit",
                              )}`
                            : "-"}
                        </dd>
                      </div>
                      <div>
                        <dt>{t(language, "screenQualityBitrate")}</dt>
                        <dd>
                          {screenShareStats.bitrateKbps
                            ? `${screenShareStats.bitrateKbps} ${t(
                                language,
                                "screenQualityKbps",
                              )}`
                            : "-"}
                        </dd>
                      </div>
                      <div>
                        <dt>{t(language, "screenQualityPath")}</dt>
                        <dd>
                          {screenShareStats.path === "relay"
                            ? t(language, "screenQualityRelay")
                            : screenShareStats.path === "direct"
                              ? t(language, "screenQualityDirect")
                              : t(language, "screenQualityUnknownPath")}
                          {screenShareStats.roundTripMs
                            ? ` / ${screenShareStats.roundTripMs} ms`
                            : ""}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p>{t(language, "screenQualityWaitingStats")}</p>
                  )}
                </section>
              ) : (
                <p className="screen-quality-notice">
                  {t(language, "screenQuality4kNotice")}
                </p>
              )}

              <div className="screen-quality-actions">
                <button
                  type="button"
                  onClick={closeScreenShareSettings}
                  className="garden-button garden-button-quiet h-12 px-4 text-base"
                >
                  {t(language, "screenQualityCancel")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void (isScreenSharing
                      ? handleApplyScreenShareQuality()
                      : handleStartScreenShareFromSettings())
                  }
                  disabled={isApplyingScreenQuality}
                  className="garden-button garden-button-primary h-12 px-4 text-base"
                >
                  {isApplyingScreenQuality
                    ? t(language, "screenQualityApplying")
                    : isScreenSharing
                      ? t(language, "screenQualityApply")
                      : t(language, "screenQualityStart")}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
