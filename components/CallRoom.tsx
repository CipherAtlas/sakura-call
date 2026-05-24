"use client";

import {
  ArrowLeft,
  Camera,
  CameraOff,
  Captions,
  Copy,
  Flower2,
  MessageSquare,
  Minimize2,
  Mic,
  MicOff,
  PhoneOff,
  Pin,
  ScreenShare,
  ScreenShareOff,
  Settings,
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
import {
  VideoGrid,
  type MediaSurfaceId,
  type MediaSurfaceSlot,
} from "@/components/VideoGrid";
import { createAudioCapture, AudioCaptureController } from "@/lib/audioCapture";
import { createEnhancedMicrophoneStream } from "@/lib/audioEnhancement";
import {
  clearSavedLanguage,
  getSavedDisplayName,
  getSavedLanguage,
  Language,
  languageLabel,
  saveDisplayName,
  saveLanguage,
  t,
} from "@/lib/i18n";
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

type RoomInfo = {
  roomId: string;
  exists: boolean;
  isCreator: boolean;
  participantCount: number;
  subtitleServiceStarted: boolean;
  roomCode?: string;
};

type JoinResponse =
  | {
      ok: true;
      participantCount: number;
      otherParticipants: Array<{ participantId: string; displayName: string }>;
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

type SpeakingMonitor = {
  analyser: AnalyserNode;
  audioContext: AudioContext;
  frameId: number;
  source: MediaStreamAudioSourceNode;
};

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
  const source = audioContext.createMediaStreamSource(
    new MediaStream(audioTracks),
  );
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

type StartSubtitleServiceResponse =
  | { ok: true }
  | { ok: false; reason: "HOST_ONLY" | "RATE_LIMITED" | "NOT_CONFIGURED" };

type StopSubtitleServiceResponse =
  | { ok: true }
  | { ok: false; reason: "HOST_ONLY" | "RATE_LIMITED" };

type TurnPhase =
  | "disabled"
  | "idle"
  | "checking"
  | "starting-vm"
  | "waiting-vm"
  | "waiting-ssh"
  | "starting-turn"
  | "ready"
  | "stopping"
  | "error";

type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  host?: string;
  updatedAt: number;
};

type CallState =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "disconnected";

type SubtitleNoticeKey =
  | "subtitleServiceStartedNotice"
  | "subtitleServiceStoppedNotice"
  | "callHostLeftNotice";
type LayoutPickerMode = "all" | MediaSurfaceSlot;

const captionLogLimit = 60;
const videoCallingEnabled = true;

function getSessionParticipantId() {
  const key = "jec.participantId";
  const existing = window.sessionStorage.getItem(key);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.sessionStorage.setItem(key, next);
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
    return t(language, "thirdParticipantBlocked");
  }

  if (reason === "INVALID_SESSION") {
    return t(language, "roomNotFound");
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

function isTurnBusy(phase: TurnPhase | undefined) {
  return (
    phase === "checking" ||
    phase === "starting-vm" ||
    phase === "waiting-vm" ||
    phase === "waiting-ssh" ||
    phase === "starting-turn" ||
    phase === "stopping"
  );
}

function attachStreamToVideo(
  video: HTMLVideoElement | null,
  stream: MediaStream | null,
) {
  if (!video) {
    return;
  }

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  if (stream) {
    void video.play().catch(() => undefined);
  }
}

function turnStatusLabel(language: Language, status: TurnStatus | null) {
  switch (status?.phase) {
    case "disabled":
      return t(language, "turnRelayNotConfigured");
    case "checking":
      return t(language, "turnRelayChecking");
    case "starting-vm":
      return t(language, "turnRelayStartingVm");
    case "waiting-vm":
      return t(language, "turnRelayWaitingVm");
    case "waiting-ssh":
      return t(language, "turnRelayWaitingNetwork");
    case "starting-turn":
      return t(language, "turnRelayStarting");
    case "ready":
      return t(language, "turnRelayReady");
    case "stopping":
      return t(language, "turnRelayStopping");
    case "error":
      return t(language, "turnRelayError");
    default:
      return t(language, "turnRelayOff");
  }
}

export function CallRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const socket = useMemo(() => getSocket(), []);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localScreenRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<HTMLVideoElement>(null);
  const fullscreenShellRef = useRef<HTMLElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const audioCaptureRef = useRef<AudioCaptureController | null>(null);
  const audioEnhancementStopRef = useRef<(() => void) | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const remoteCameraStreamRef = useRef<MediaStream | null>(null);
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);
  const remoteScreenStreamIdRef = useRef("");
  const remoteVideoTrackStreamIdsRef = useRef<Map<string, string>>(new Map());
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const participantIdRef = useRef<string>("");
  const participantSessionTokenRef = useRef("");
  const roomCodeRef = useRef("");
  const languageRef = useRef<Language>("en");
  const displayNameRef = useRef("");
  const roomEndRedirectTimeoutRef = useRef<number | null>(null);
  const speakingMonitorRef = useRef<SpeakingMonitor | null>(null);
  const remoteSpeakingMonitorRef = useRef<SpeakingMonitor | null>(null);
  const isLocalSpeakingRef = useRef(false);
  const isRemoteSpeakingRef = useRef(false);
  const lastTurnReadyAtRef = useRef(0);

  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [remoteDisplayName, setRemoteDisplayName] = useState("");
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [isCodeCopied, setIsCodeCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [startWithCameraOff, setStartWithCameraOff] = useState(false);
  const [isPreparingMedia, setIsPreparingMedia] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [isRemoteSpeaking, setIsRemoteSpeaking] = useState(false);
  const [dominantSurface, setDominantSurface] =
    useState<MediaSurfaceId | null>(null);
  const [smallSurface, setSmallSurface] = useState<MediaSurfaceId | null>(null);
  const [isSmallSurfaceHidden, setIsSmallSurfaceHidden] = useState(false);
  const [showLayoutPicker, setShowLayoutPicker] = useState(false);
  const [layoutPickerMode, setLayoutPickerMode] =
    useState<LayoutPickerMode>("all");
  const [fullscreenSurface, setFullscreenSurface] =
    useState<MediaSurfaceId | null>(null);
  const [
    isFullscreenConversationExpanded,
    setIsFullscreenConversationExpanded,
  ] = useState(true);
  const [isConversationVisible, setIsConversationVisible] = useState(true);
  const [isScreenShareSupported, setIsScreenShareSupported] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [hasRemoteScreenShare, setHasRemoteScreenShare] = useState(false);
  const [isRoomHost, setIsRoomHost] = useState(false);
  const [isSubtitleServiceStarted, setIsSubtitleServiceStarted] =
    useState(false);
  const [isStartingSubtitleService, setIsStartingSubtitleService] =
    useState(false);
  const [partialCaption, setPartialCaption] = useState<CaptionEvent | null>(
    null,
  );
  const [finalCaption, setFinalCaption] = useState<CaptionEvent | null>(null);
  const [captionLog, setCaptionLog] = useState<CaptionEvent[]>([]);
  const [localPartialCaption, setLocalPartialCaption] =
    useState<CaptionEvent | null>(null);
  const [localFinalCaption, setLocalFinalCaption] =
    useState<CaptionEvent | null>(null);
  const [localCaptionLog, setLocalCaptionLog] = useState<CaptionEvent[]>([]);
  const [subtitleNoticeId, setSubtitleNoticeId] = useState(0);
  const [subtitleNoticeKey, setSubtitleNoticeKey] = useState<SubtitleNoticeKey>(
    "subtitleServiceStartedNotice",
  );
  const [showSubtitleNotice, setShowSubtitleNotice] = useState(false);
  const [turnStatus, setTurnStatus] = useState<TurnStatus | null>(null);
  const [isTurnActionPending, setIsTurnActionPending] = useState(false);

  const showSubtitleServiceBanner = useCallback(
    (noticeKey: SubtitleNoticeKey) => {
      setSubtitleNoticeKey(noticeKey);
      setSubtitleNoticeId((value) => value + 1);
      setShowSubtitleNotice(true);
    },
    [],
  );

  useEffect(() => {
    const savedLanguage = getSavedLanguage();
    setLanguage(savedLanguage);

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
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    if (language) {
      languageRef.current = language;
      audioCaptureRef.current?.updateMetadata({
        roomId,
        participantId: participantIdRef.current,
        spokenLanguage: language,
      });

      if (socket.connected) {
        socket.emit("participant:language", {
          roomId,
          participantId: participantIdRef.current,
          spokenLanguage: language,
        });
      }
    }
  }, [language, roomId, socket]);

  useEffect(() => {
    if (!showSubtitleNotice) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowSubtitleNotice(false);
    }, 5000);

    return () => window.clearTimeout(timeout);
  }, [showSubtitleNotice, subtitleNoticeId]);

  useEffect(() => {
    setIsScreenShareSupported(
      typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getDisplayMedia),
    );
  }, []);

  useEffect(() => {
    if (!showSettings && !showLayoutPicker) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowSettings(false);
        setShowLayoutPicker(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("garden-modal-open");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("garden-modal-open");
    };
  }, [showLayoutPicker, showSettings]);

  useEffect(() => {
    if (!fullscreenSurface) {
      return;
    }

    function handleFullscreenChange() {
      if (!document.fullscreenElement) {
        setFullscreenSurface(null);
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.body.classList.add("garden-fullscreen-open");

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.body.classList.remove("garden-fullscreen-open");
    };
  }, [fullscreenSurface]);

  useEffect(() => {
    const localVideo = localVideoRef.current;
    if (localVideo && localStreamRef.current) {
      attachStreamToVideo(
        localVideo,
        new MediaStream(localStreamRef.current.getVideoTracks()),
      );
    }
  }, [
    callState,
    dominantSurface,
    fullscreenSurface,
    isCameraEnabled,
    isScreenSharing,
    smallSurface,
  ]);

  useEffect(() => {
    const remoteVideo = remoteVideoRef.current;
    if (remoteVideo && remoteCameraStreamRef.current) {
      attachStreamToVideo(remoteVideo, remoteCameraStreamRef.current);
    }
  }, [
    callState,
    dominantSurface,
    fullscreenSurface,
    hasRemoteScreenShare,
    hasRemoteVideo,
    smallSurface,
  ]);

  useEffect(() => {
    const localScreen = localScreenRef.current;
    if (localScreen && localScreenStreamRef.current) {
      attachStreamToVideo(localScreen, localScreenStreamRef.current);
    }
  }, [callState, dominantSurface, fullscreenSurface, isScreenSharing, smallSurface]);

  useEffect(() => {
    const remoteScreen = remoteScreenRef.current;
    if (remoteScreen && remoteScreenStreamRef.current) {
      attachStreamToVideo(remoteScreen, remoteScreenStreamRef.current);
    }
  }, [
    callState,
    dominantSurface,
    fullscreenSurface,
    hasRemoteScreenShare,
    smallSurface,
  ]);

  const stopLocalSpeakingMonitor = useCallback(() => {
    stopSpeakingMonitor(
      speakingMonitorRef,
      isLocalSpeakingRef,
      setIsLocalSpeaking,
    );
  }, []);

  const startLocalSpeakingMonitor = useCallback((stream: MediaStream) => {
    startSpeakingMonitor({
      monitorRef: speakingMonitorRef,
      setSpeaking: setIsLocalSpeaking,
      speakingRef: isLocalSpeakingRef,
      stream,
    });
  }, []);

  const stopRemoteSpeakingMonitor = useCallback(() => {
    stopSpeakingMonitor(
      remoteSpeakingMonitorRef,
      isRemoteSpeakingRef,
      setIsRemoteSpeaking,
    );
  }, []);

  const startRemoteSpeakingMonitor = useCallback((stream: MediaStream) => {
    startSpeakingMonitor({
      monitorRef: remoteSpeakingMonitorRef,
      quietFramesToStop: 24,
      setSpeaking: setIsRemoteSpeaking,
      speakingRef: isRemoteSpeakingRef,
      stream,
      threshold: 0.018,
    });
  }, []);

  const removePeerSenderForTrack = useCallback((track: MediaStreamTrack) => {
    const peerConnection = peerConnectionRef.current;
    const sender = peerConnection
      ?.getSenders()
      .find((item) => item.track?.id === track.id);

    if (peerConnection && sender) {
      peerConnection.removeTrack(sender);
    }
  }, []);

  const requestCameraTrack = useCallback(async () => {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 960 },
        height: { ideal: 720 },
      },
    });
    const [track] = videoStream.getVideoTracks();

    if (!track) {
      throw new Error("camera-unavailable");
    }

    return track;
  }, []);

  const updateRemoteMediaState = useCallback(() => {
    setHasRemoteVideo(
      remoteCameraStreamRef.current
        ?.getVideoTracks()
        .some((track) => track.readyState === "live") ?? false,
    );
    setHasRemoteScreenShare(
      remoteScreenStreamRef.current
        ?.getVideoTracks()
        .some((track) => track.readyState === "live") ?? false,
    );
  }, []);

  const ensurePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = createPeerConnection();
    const remoteAudioStream = new MediaStream();
    const remoteCameraStream = new MediaStream();
    const remoteScreenStream = new MediaStream();
    remoteAudioStreamRef.current = remoteAudioStream;
    remoteCameraStreamRef.current = remoteCameraStream;
    remoteScreenStreamRef.current = remoteScreenStream;

    attachStreamToVideo(remoteVideoRef.current, remoteCameraStream);

    attachStreamToVideo(remoteScreenRef.current, remoteScreenStream);

    if (localStreamRef.current) {
      addStreamTracks(peerConnection, localStreamRef.current);
    }

    if (localScreenStreamRef.current) {
      addStreamTracks(peerConnection, localScreenStreamRef.current);
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc:ice-candidate", {
          roomId,
          from: participantIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    peerConnection.ontrack = (event) => {
      const incomingStreamId = event.streams[0]?.id ?? "";
      const isScreenTrack =
        event.track.kind === "video" &&
        Boolean(incomingStreamId) &&
        incomingStreamId === remoteScreenStreamIdRef.current;
      const targetStream =
        event.track.kind === "audio"
          ? remoteAudioStream
          : isScreenTrack
            ? remoteScreenStream
            : remoteCameraStream;

      if (event.track.kind === "video") {
        remoteVideoTrackStreamIdsRef.current.set(
          event.track.id,
          incomingStreamId,
        );
      }

      if (
        !targetStream.getTracks().some((track) => track.id === event.track.id)
      ) {
        targetStream.addTrack(event.track);
      }

      event.track.onended = () => {
        remoteVideoTrackStreamIdsRef.current.delete(event.track.id);
        updateRemoteMediaState();
      };

      if (
        !remoteSpeakingMonitorRef.current &&
        remoteAudioStream
          .getAudioTracks()
          .some((track) => track.readyState === "live")
      ) {
        startRemoteSpeakingMonitor(remoteAudioStream);
      }

      updateRemoteMediaState();
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
        setCallState("disconnected");
      }
    };

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  }, [roomId, socket, startRemoteSpeakingMonitor, updateRemoteMediaState]);

  const createAndSendOffer = useCallback(async ({ iceRestart = false } = {}) => {
    const peerConnection = ensurePeerConnection();

    if (peerConnection.signalingState !== "stable") {
      return;
    }

    await refreshPeerConnectionIceServers(peerConnection).catch(() => false);
    const offer = await peerConnection.createOffer({
      iceRestart,
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await peerConnection.setLocalDescription(offer);

    socket.emit("webrtc:offer", {
      roomId,
      from: participantIdRef.current,
      description: peerConnection.localDescription,
    });
  }, [ensurePeerConnection, roomId, socket]);

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

  const handleStartTurnRelay = useCallback(async () => {
    setIsTurnActionPending(true);

    try {
      const response = await fetch("/api/turn/start", {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        setTurnStatus((await response.json()) as TurnStatus);
      } else {
        setError(t(languageRef.current, "turnRelayUnavailable"));
      }
    } catch {
      setError(t(languageRef.current, "turnRelayUnavailable"));
    } finally {
      setIsTurnActionPending(false);
      void loadTurnStatus();
    }
  }, [loadTurnStatus]);

  const handleStopTurnRelay = useCallback(async () => {
    setIsTurnActionPending(true);

    try {
      const response = await fetch("/api/turn/stop", {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        setTurnStatus((await response.json()) as TurnStatus);
      } else {
        setError(t(languageRef.current, "turnRelayUnavailable"));
      }
    } catch {
      setError(t(languageRef.current, "turnRelayUnavailable"));
    } finally {
      setIsTurnActionPending(false);
      void loadTurnStatus();
    }
  }, [loadTurnStatus]);

  useEffect(() => {
    if (!roomInfo?.isCreator && !isRoomHost) {
      setTurnStatus(null);
      return;
    }

    let isActive = true;

    async function pollTurnStatus() {
      const nextStatus = await loadTurnStatus().catch(() => null);

      if (!isActive || !nextStatus) {
        return;
      }

      if (
        nextStatus.phase === "ready" &&
        nextStatus.updatedAt !== lastTurnReadyAtRef.current
      ) {
        lastTurnReadyAtRef.current = nextStatus.updatedAt;

        if (callState !== "idle" && remoteDisplayName) {
          await createAndSendOffer({ iceRestart: true }).catch(() => undefined);
        }
      }
    }

    void pollTurnStatus();
    const interval = window.setInterval(() => {
      const phase = turnStatus?.phase;

      if (isTurnBusy(phase)) {
        void pollTurnStatus();
      }
    }, 2500);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [
    callState,
    createAndSendOffer,
    isRoomHost,
    loadTurnStatus,
    remoteDisplayName,
    roomInfo?.isCreator,
    turnStatus?.phase,
  ]);

  const startLocalSubtitleCapture = useCallback(async () => {
    if (audioCaptureRef.current) {
      return true;
    }

    const stream = localStreamRef.current;

    if (!stream) {
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
  }, [roomId, socket]);

  const stopLocalSubtitleCapture = useCallback(() => {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    setPartialCaption(null);
    setLocalPartialCaption(null);
  }, []);

  const rememberParticipantSessionToken = useCallback(
    (token: string) => {
      participantSessionTokenRef.current = token;
      saveParticipantSessionTokenForRoom(roomId, token);
    },
    [roomId],
  );

  const flushPendingIceCandidates = useCallback(
    async (peerConnection: RTCPeerConnection) => {
      if (!peerConnection.remoteDescription) {
        return;
      }

      const pendingCandidates = pendingIceCandidatesRef.current;
      pendingIceCandidatesRef.current = [];

      for (const candidate of pendingCandidates) {
        await peerConnection.addIceCandidate(candidate).catch(() => undefined);
      }
    },
    [],
  );

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
    setIsMediaReady(false);
    setIsCameraEnabled(false);
    setIsScreenSharing(false);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (localScreenRef.current) {
      localScreenRef.current.srcObject = null;
    }
  }, [stopLocalMediaTracks, stopLocalSpeakingMonitor]);

  const resetRemoteMediaState = useCallback(() => {
    stopRemoteSpeakingMonitor();
    remoteAudioStreamRef.current = null;
    remoteCameraStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    remoteScreenStreamIdRef.current = "";
    remoteVideoTrackStreamIdsRef.current.clear();
    setHasRemoteVideo(false);
    setHasRemoteScreenShare(false);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    if (remoteScreenRef.current) {
      remoteScreenRef.current.srcObject = null;
    }
  }, [stopRemoteSpeakingMonitor]);

  useEffect(() => {
    async function handlePeerJoined(payload: { displayName?: string }) {
      setRemoteDisplayName(payload.displayName ?? "");
      setCallState("connecting");
      if (localScreenStreamRef.current) {
        socket.emit("media:screen-started", {
          roomId,
          from: participantIdRef.current,
          streamId: localScreenStreamRef.current.id,
        });
      }

      if (hasLiveVideoTrack(localStreamRef.current)) {
        socket.emit("media:camera-started", {
          roomId,
          from: participantIdRef.current,
        });
      }

      if (isRoomHost || roomInfo?.isCreator) {
        await createAndSendOffer().catch(() => undefined);
      }
    }

    async function handleOffer(payload: {
      description: RTCSessionDescriptionInit;
      from: string;
    }) {
      const peerConnection = ensurePeerConnection();
      await refreshPeerConnectionIceServers(peerConnection).catch(() => false);
      await peerConnection.setRemoteDescription(payload.description);
      await flushPendingIceCandidates(peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("webrtc:answer", {
        roomId,
        from: participantIdRef.current,
        description: peerConnection.localDescription,
      });
    }

    async function handleAnswer(payload: {
      description: RTCSessionDescriptionInit;
    }) {
      const peerConnection = ensurePeerConnection();

      if (peerConnection.signalingState !== "stable") {
        await peerConnection.setRemoteDescription(payload.description);
        await flushPendingIceCandidates(peerConnection);
      }
    }

    async function handleIceCandidate(payload: {
      candidate: RTCIceCandidateInit;
    }) {
      const peerConnection = ensurePeerConnection();

      if (!peerConnection.remoteDescription) {
        pendingIceCandidatesRef.current.push(payload.candidate);
        return;
      }

      await peerConnection
        .addIceCandidate(payload.candidate)
        .catch(() => undefined);
    }

    function handleCaption(caption: CaptionEvent) {
      if (caption.isFinal) {
        setFinalCaption(caption);
        setPartialCaption(null);
        setCaptionLog((log) => appendCaptionLog(log, caption));
      } else {
        setPartialCaption(caption);
      }
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
      const started = await startLocalSubtitleCapture();

      if (!started) {
        setError(t(languageRef.current, "subtitleServiceUnavailable"));
      }
    }

    function handleSubtitleServiceStopped() {
      setIsSubtitleServiceStarted(false);
      showSubtitleServiceBanner("subtitleServiceStoppedNotice");
      stopLocalSubtitleCapture();
    }

    function handlePeerLeft() {
      resetRemoteMediaState();
      setRemoteDisplayName("");
      setCallState("waiting");
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
      pendingIceCandidatesRef.current = [];
    }

    function handleRoomEnded(payload?: { endedBy?: string }) {
      stopLocalSubtitleCapture();
      resetRemoteMediaState();
      resetLocalMediaState();
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
      pendingIceCandidatesRef.current = [];
      setRemoteDisplayName("");
      setCallState("disconnected");

      if (payload?.endedBy === participantIdRef.current) {
        router.push("/");
        return;
      }

      showSubtitleServiceBanner("callHostLeftNotice");
      if (roomEndRedirectTimeoutRef.current !== null) {
        window.clearTimeout(roomEndRedirectTimeoutRef.current);
      }
      roomEndRedirectTimeoutRef.current = window.setTimeout(() => {
        roomEndRedirectTimeoutRef.current = null;
        router.push("/");
      }, 5000);
    }

    function handleReconnectAttempt() {
      setCallState("reconnecting");
    }

    function handleRemoteScreenStarted(payload: { streamId?: string }) {
      const nextStreamId = payload.streamId ?? "";
      remoteScreenStreamIdRef.current = nextStreamId;

      if (!nextStreamId) {
        return;
      }

      const cameraStream = remoteCameraStreamRef.current;
      const screenStream =
        remoteScreenStreamRef.current ?? new MediaStream();
      remoteScreenStreamRef.current = screenStream;

      for (const track of cameraStream?.getVideoTracks() ?? []) {
        if (remoteVideoTrackStreamIdsRef.current.get(track.id) === nextStreamId) {
          cameraStream?.removeTrack(track);
          if (!screenStream.getTracks().some((item) => item.id === track.id)) {
            screenStream.addTrack(track);
          }
        }
      }

      attachStreamToVideo(remoteVideoRef.current, cameraStream);
      attachStreamToVideo(remoteScreenRef.current, screenStream);
      updateRemoteMediaState();
    }

    function handleRemoteScreenStopped() {
      remoteScreenStreamIdRef.current = "";
      setDominantSurface((current) =>
        current === "remote-screen" ? null : current,
      );
      setSmallSurface((current) =>
        current === "remote-screen" ? null : current,
      );
      for (const track of remoteScreenStreamRef.current?.getTracks() ?? []) {
        remoteVideoTrackStreamIdsRef.current.delete(track.id);
        remoteScreenStreamRef.current?.removeTrack(track);
      }
      setHasRemoteScreenShare(false);
      if (remoteScreenRef.current) {
        remoteScreenRef.current.srcObject = null;
      }
    }

    function handleRemoteCameraStarted() {
      updateRemoteMediaState();
    }

    function handleRemoteCameraStopped() {
      for (const track of remoteCameraStreamRef.current?.getVideoTracks() ?? []) {
        remoteVideoTrackStreamIdsRef.current.delete(track.id);
        remoteCameraStreamRef.current?.removeTrack(track);
      }

      setHasRemoteVideo(false);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    }

    async function handleReconnect() {
      if (!languageRef.current || callState === "idle") {
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
          setRemoteDisplayName(
            response.otherParticipants[0]?.displayName ?? "",
          );
          if (response.subtitleServiceStarted) {
            void startLocalSubtitleCapture();
          }
          if (response.isCreator && response.otherParticipants.length > 0) {
            await createAndSendOffer();
          }
        },
      );
    }

    socket.on("peer:joined", handlePeerJoined);
    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    socket.on("media:screen-started", handleRemoteScreenStarted);
    socket.on("media:screen-stopped", handleRemoteScreenStopped);
    socket.on("media:camera-started", handleRemoteCameraStarted);
    socket.on("media:camera-stopped", handleRemoteCameraStopped);
    socket.on("caption", handleCaption);
    socket.on("caption:preview", handleCaptionPreview);
    socket.on("caption:error", handleCaptionError);
    socket.on("subtitle:service-started", handleSubtitleServiceStarted);
    socket.on("subtitle:service-stopped", handleSubtitleServiceStopped);
    socket.on("peer:left", handlePeerLeft);
    socket.on("room:ended", handleRoomEnded);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);

    return () => {
      socket.off("peer:joined", handlePeerJoined);
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:answer", handleAnswer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
      socket.off("media:screen-started", handleRemoteScreenStarted);
      socket.off("media:screen-stopped", handleRemoteScreenStopped);
      socket.off("media:camera-started", handleRemoteCameraStarted);
      socket.off("media:camera-stopped", handleRemoteCameraStopped);
      socket.off("caption", handleCaption);
      socket.off("caption:preview", handleCaptionPreview);
      socket.off("caption:error", handleCaptionError);
      socket.off("subtitle:service-started", handleSubtitleServiceStarted);
      socket.off("subtitle:service-stopped", handleSubtitleServiceStopped);
      socket.off("peer:left", handlePeerLeft);
      socket.off("room:ended", handleRoomEnded);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
    };
  }, [
    callState,
    createAndSendOffer,
    ensurePeerConnection,
    roomId,
    router,
    socket,
    isRoomHost,
    roomInfo?.isCreator,
    resetLocalMediaState,
    resetRemoteMediaState,
    flushPendingIceCandidates,
    rememberParticipantSessionToken,
    showSubtitleServiceBanner,
    startLocalSubtitleCapture,
    stopLocalSubtitleCapture,
    updateRemoteMediaState,
  ]);

  useEffect(() => {
    return () => {
      if (roomEndRedirectTimeoutRef.current !== null) {
        window.clearTimeout(roomEndRedirectTimeoutRef.current);
        roomEndRedirectTimeoutRef.current = null;
      }
      stopLocalSubtitleCapture();
      resetRemoteMediaState();
      resetLocalMediaState();
      closePeerConnection(peerConnectionRef.current);
      if (socket.connected) {
        socket.emit("room:leave", {
          roomId,
          participantId: participantIdRef.current,
        });
      }
    };
  }, [
    resetLocalMediaState,
    resetRemoteMediaState,
    roomId,
    socket,
    stopLocalSubtitleCapture,
  ]);

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

    const enhancedMicrophone =
      await createEnhancedMicrophoneStream(audioStream);
    audioEnhancementStopRef.current = enhancedMicrophone.stop;
    const combinedStream = new MediaStream(
      enhancedMicrophone.stream.getAudioTracks(),
    );

    for (const track of combinedStream.getAudioTracks()) {
      track.enabled = !isMuted;
    }

    if (!videoCallingEnabled || startWithCameraOff) {
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

    attachStreamToVideo(localVideoRef.current, combinedStream);

    return combinedStream;
  }, [
    isMuted,
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

  async function handleJoinCall(preparedStream?: MediaStream) {
    if (!language || !roomInfo) {
      return;
    }

    setError("");
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
    const streamForJoin = stream;

    if (!socket.connected) {
      socket.connect();
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
        const peerConnection = ensurePeerConnection();
        addStreamTracks(peerConnection, streamForJoin);
        setIsRoomHost(response.isCreator);
        setIsSubtitleServiceStarted(response.subtitleServiceStarted);
        setRemoteDisplayName(response.otherParticipants[0]?.displayName ?? "");

        setCallState(
          response.otherParticipants.length > 0 ? "connecting" : "waiting",
        );

        if (hasLiveVideoTrack(streamForJoin)) {
          socket.emit("media:camera-started", {
            roomId,
            from: participantIdRef.current,
          });
        }

        if (response.subtitleServiceStarted) {
          await startLocalSubtitleCapture();
        }

        if (response.isCreator && response.otherParticipants.length > 0) {
          await createAndSendOffer();
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
    const nextMuted = !isMuted;
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }
    setIsMuted(nextMuted);
  }

  async function handleToggleCamera() {
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
      attachStreamToVideo(
        localVideoRef.current,
        new MediaStream(stream.getVideoTracks()),
      );
      if (callState !== "idle") {
        socket.emit("media:camera-stopped", {
          roomId,
          from: participantIdRef.current,
        });
      }
      if (callState !== "idle" && remoteDisplayName) {
        await createAndSendOffer();
      }
      return;
    }

    try {
      const track = await requestCameraTrack();
      stream.addTrack(track);
      if (callState !== "idle" && remoteDisplayName) {
        const peerConnection = ensurePeerConnection();
        peerConnection.addTrack(track, stream);
        await createAndSendOffer();
      }
      attachStreamToVideo(localVideoRef.current, new MediaStream([track]));
      setIsCameraEnabled(true);
      if (callState !== "idle") {
        socket.emit("media:camera-started", {
          roomId,
          from: participantIdRef.current,
        });
      }
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

  async function stopScreenShare({ renegotiate = true } = {}) {
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
    setDominantSurface((current) =>
      current === "local-screen" ? null : current,
    );
    setSmallSurface((current) =>
      current === "local-screen" ? null : current,
    );
    if (localScreenRef.current) {
      localScreenRef.current.srcObject = null;
    }

    socket.emit("media:screen-stopped", {
      roomId,
      from: participantIdRef.current,
    });

    if (renegotiate && callState !== "idle" && remoteDisplayName) {
      await createAndSendOffer();
    }
  }

  async function handleToggleScreenShare() {
    if (isScreenSharing) {
      await stopScreenShare();
      return;
    }

    if (
      !isScreenShareSupported ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      setCameraError(t(languageRef.current, "screenShareUnavailable"));
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      const [screenTrack] = screenStream.getVideoTracks();

      if (!screenTrack) {
        return;
      }

      localScreenStreamRef.current = screenStream;
      screenTrack.onended = () => {
        void stopScreenShare();
      };
      attachStreamToVideo(localScreenRef.current, screenStream);

      socket.emit("media:screen-started", {
        roomId,
        from: participantIdRef.current,
        streamId: screenStream.id,
      });

      if (callState !== "idle" && remoteDisplayName) {
        const peerConnection = ensurePeerConnection();
        peerConnection.addTrack(screenTrack, screenStream);
        await createAndSendOffer();
      }

      setIsScreenSharing(true);
      setCameraError("");
    } catch (mediaError) {
      if (
        mediaError instanceof DOMException &&
        mediaError.name === "NotAllowedError"
      ) {
        return;
      }

      setCameraError(t(languageRef.current, "screenShareUnavailable"));
    }
  }

  function handleToggleSubtitleService() {
    if (!isRoomHost || isStartingSubtitleService) {
      return;
    }

    if (isSubtitleServiceStarted) {
      socket.emit(
        "subtitle:stop-service",
        {
          roomId,
          participantId: participantIdRef.current,
        },
        (response: StopSubtitleServiceResponse) => {
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

    setIsStartingSubtitleService(true);
    socket.emit(
      "subtitle:start-service",
      {
        roomId,
        participantId: participantIdRef.current,
      },
      async (response: StartSubtitleServiceResponse) => {
        setIsStartingSubtitleService(false);

        if (!response.ok) {
          setError(t(languageRef.current, "subtitleServiceUnavailable"));
          return;
        }

        setIsSubtitleServiceStarted(true);
        const started = await startLocalSubtitleCapture();

        if (!started) {
          setError(t(languageRef.current, "subtitleServiceUnavailable"));
        }
      },
    );
  }

  function handleLeaveCall() {
    if (roomEndRedirectTimeoutRef.current !== null) {
      window.clearTimeout(roomEndRedirectTimeoutRef.current);
      roomEndRedirectTimeoutRef.current = null;
    }
    stopLocalSubtitleCapture();
    stopRemoteSpeakingMonitor();
    resetLocalMediaState();
    closePeerConnection(peerConnectionRef.current);
    peerConnectionRef.current = null;
    pendingIceCandidatesRef.current = [];
    socket.emit("room:leave", {
      roomId,
      participantId: participantIdRef.current,
    });
    router.push("/");
  }

  const statusText = useMemo(() => {
    if (!language) {
      return "";
    }

    if (callState === "connecting") {
      return t(language, "connecting");
    }

    if (callState === "waiting") {
      return t(language, "waitingForOther");
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

    return roomInfo?.isCreator
      ? t(language, "roomSetup")
      : t(language, "joinCall");
  }, [callState, language, roomInfo?.isCreator]);

  const canEnterRoom =
    Boolean(language && roomInfo) &&
    (roomInfo?.isCreator || /^\d{4}$/.test(roomCode));
  const canPrepareMedia =
    callState === "idle" &&
    Boolean(roomInfo) &&
    !isPreparingMedia &&
    !isMediaReady;
  const canJoin =
    callState === "idle" && canEnterRoom && isMediaReady && !isPreparingMedia;
  const isCameraOnForControls = isMediaReady
    ? isCameraEnabled
    : !startWithCameraOff;
  const hostRoomCode = roomInfo?.isCreator ? roomInfo.roomCode : undefined;
  const canManageTurnRelay = Boolean(roomInfo?.isCreator || isRoomHost);
  const turnRelayBusy = isTurnBusy(turnStatus?.phase);
  const turnRelayReady = turnStatus?.phase === "ready";
  const turnRelayProgress = Math.max(
    0,
    Math.min(100, turnStatus?.progress ?? 0),
  );
  const remoteParticipantStatus = useMemo(() => {
    if (!language) {
      return "";
    }

    return "";
  }, [language]);

  const layoutSurfaces = useMemo(() => {
    if (!language) {
      return [];
    }

    return [
      {
        id: "remote-screen" as const,
        isAvailable: hasRemoteScreenShare,
        label: t(language, "remoteScreen"),
        status: t(language, "screenShareOn"),
      },
      {
        id: "local-screen" as const,
        isAvailable: isScreenSharing,
        label: t(language, "localScreen"),
        status: t(language, "screenShareOn"),
      },
      {
        id: "remote-video" as const,
        isAvailable: Boolean(remoteDisplayName),
        label: remoteDisplayName || t(language, "remoteVideo"),
        status: remoteParticipantStatus,
      },
      {
        id: "local-video" as const,
        isAvailable: true,
        label: displayName,
        status: "",
      },
    ].filter((surface) => surface.isAvailable);
  }, [
    displayName,
    hasRemoteScreenShare,
    isScreenSharing,
    language,
    remoteDisplayName,
    remoteParticipantStatus,
  ]);
  const availableSurfaceIds = useMemo(
    () => layoutSurfaces.map((surface) => surface.id),
    [layoutSurfaces],
  );
  const resolvedDominantSurface = useMemo<MediaSurfaceId | null>(() => {
    if (dominantSurface && availableSurfaceIds.includes(dominantSurface)) {
      return dominantSurface;
    }

    return availableSurfaceIds[0] ?? null;
  }, [availableSurfaceIds, dominantSurface]);
  const resolvedSmallSurface = useMemo<MediaSurfaceId | null>(() => {
    if (isSmallSurfaceHidden) {
      return null;
    }

    if (
      smallSurface &&
      smallSurface !== resolvedDominantSurface &&
      availableSurfaceIds.includes(smallSurface)
    ) {
      return smallSurface;
    }

    return (
      availableSurfaceIds.find((surfaceId) => surfaceId !== resolvedDominantSurface) ??
      null
    );
  }, [
    availableSurfaceIds,
    isSmallSurfaceHidden,
    resolvedDominantSurface,
    smallSurface,
  ]);

  useEffect(() => {
    if (!fullscreenSurface) {
      return;
    }

    if (availableSurfaceIds.includes(fullscreenSurface)) {
      return;
    }

    setFullscreenSurface(resolvedDominantSurface);
  }, [availableSurfaceIds, fullscreenSurface, resolvedDominantSurface]);

  function openLayoutPicker(mode: LayoutPickerMode) {
    setLayoutPickerMode(mode);
    setShowLayoutPicker(true);
  }

  function handleSelectDominantSurface(surfaceId: MediaSurfaceId) {
    setDominantSurface(surfaceId);
    setSmallSurface((current) => {
      if (isSmallSurfaceHidden) {
        return current;
      }

      if (current && current !== surfaceId && availableSurfaceIds.includes(current)) {
        return current;
      }

      return availableSurfaceIds.find((id) => id !== surfaceId) ?? null;
    });

    if (layoutPickerMode === "dominant") {
      setShowLayoutPicker(false);
    }
  }

  function handleSelectSmallSurface(surfaceId: MediaSurfaceId | null) {
    if (!surfaceId || surfaceId === resolvedDominantSurface) {
      setIsSmallSurfaceHidden(true);
      setSmallSurface(null);
      return;
    }

    setIsSmallSurfaceHidden(false);
    setSmallSurface(surfaceId);

    if (layoutPickerMode === "small") {
      setShowLayoutPicker(false);
    }
  }

  function handleSelectMediaSlot(slot: MediaSurfaceSlot) {
    if (!isConversationVisible) {
      if (resolvedDominantSurface && resolvedSmallSurface) {
        setDominantSurface(resolvedSmallSurface);
        setSmallSurface(resolvedDominantSurface);
        setIsSmallSurfaceHidden(false);
        return;
      }

      openLayoutPicker(slot);
      return;
    }

    openLayoutPicker(slot);
  }

  function handleToggleConversationVisibility() {
    setIsConversationVisible((current) => {
      const nextValue = !current;

      if (!nextValue) {
        setShowLayoutPicker(false);
        setIsSmallSurfaceHidden(false);

        if (!resolvedSmallSurface && resolvedDominantSurface) {
          setSmallSurface(
            availableSurfaceIds.find((id) => id !== resolvedDominantSurface) ??
              null,
          );
        }
      }

      return nextValue;
    });
  }

  function handleEnterFullscreen(surfaceId: MediaSurfaceId) {
    setFullscreenSurface(surfaceId);
    setIsFullscreenConversationExpanded(true);

    if (!document.fullscreenElement) {
      const request = document.documentElement.requestFullscreen?.();
      void request?.catch(() => undefined);
    }
  }

  function handleExitFullscreen() {
    setFullscreenSurface(null);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  const layoutPickerTitle =
    !language
      ? ""
      : layoutPickerMode === "dominant"
      ? t(language, "chooseDominantView")
      : layoutPickerMode === "small"
        ? t(language, "chooseSmallView")
        : t(language, "chooseLayout");

  function renderConversationPanel() {
    if (!language || !isConversationVisible) {
      return null;
    }

    return (
      <ConversationPanel
        language={language}
        localCaptionLog={localCaptionLog}
        localFinalCaption={localFinalCaption}
        localName={displayName}
        localPartialCaption={localPartialCaption}
        remoteCaptionLog={captionLog}
        remoteFinalCaption={finalCaption}
        remoteName={remoteDisplayName || t(language, "remoteVideo")}
        remotePartialCaption={partialCaption}
      />
    );
  }

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

      {isRoomHost ? (
        <button
          type="button"
          aria-label={
            isSubtitleServiceStarted
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

      {videoCallingEnabled ? (
        <>
          <button
            type="button"
            aria-label={
              isCameraEnabled ? t(language, "cameraOff") : t(language, "cameraOn")
            }
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
            title={
              isScreenShareSupported
                ? undefined
                : t(language, "screenShareUnavailable")
            }
            onClick={() => void handleToggleScreenShare()}
            disabled={!isScreenShareSupported}
            className={`call-control-button ${
              isScreenSharing ? "is-active" : ""
            }`}
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
        </>
      ) : null}

      <button
        type="button"
        aria-label={t(language, "openLayoutPicker")}
        onClick={() => openLayoutPicker("all")}
        disabled={layoutSurfaces.length < 2}
        className={`call-control-button ${showLayoutPicker ? "is-active" : ""}`}
      >
        <span className="call-control-icon" aria-hidden="true">
          <Pin className="h-5 w-5" />
        </span>
        <span className="call-control-label">{t(language, "pinControl")}</span>
      </button>

      <button
        type="button"
        aria-label={
          isConversationVisible
            ? t(language, "hideConversation")
            : t(language, "showConversation")
        }
        onClick={handleToggleConversationVisibility}
        className={`call-control-button ${
          isConversationVisible ? "is-active" : ""
        }`}
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
                turnRelayReady ? "is-ready" : turnRelayBusy ? "is-busy" : ""
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
          <div
            className="turn-relay-progress mt-3"
            aria-label={t(language, "turnRelayProgress")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={turnRelayProgress}
            role="progressbar"
          >
            <span style={{ width: `${turnRelayProgress}%` }} />
          </div>
          {turnStatus?.host ? (
            <p className="garden-muted mt-2 truncate text-xs font-black">
              {turnStatus.host}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => void handleStartTurnRelay()}
          disabled={
            turnRelayReady ||
            turnRelayBusy ||
            isTurnActionPending ||
            turnStatus?.phase === "disabled"
          }
          className="garden-button garden-button-secondary h-12 gap-2 px-4 text-base"
        >
          <TowerControl className="h-5 w-5" aria-hidden="true" />
          {t(language, "startTurnRelay")}
        </button>
        <button
          type="button"
          onClick={() => void handleStopTurnRelay()}
          disabled={!turnRelayReady || turnRelayBusy || isTurnActionPending}
          className="garden-button garden-button-quiet h-12 px-4 text-base"
        >
          {t(language, "stopTurnRelay")}
        </button>
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
      className={`garden-scene safe-bottom min-h-dvh px-4 py-4 sm:px-6 lg:px-8 ${
        callState === "idle" ? "" : "call-scene-active"
      } ${isConversationVisible ? "" : "is-conversation-hidden"}`}
    >
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
        className={`mx-auto grid w-full gap-3 ${
          callState === "idle" ? "max-w-xl" : "max-w-[min(96rem,100%)]"
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
            } ${
              callState === "idle" ? "p-4 sm:p-5" : "p-3 sm:p-4"
            }`}
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
            </div>
            <div
              className={`call-topbar-actions flex min-w-0 shrink-0 items-center gap-2 ${
                hostRoomCode ? "max-sm:w-full" : ""
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
                  className="garden-button garden-button-quiet h-12 min-w-0 flex-1 gap-2 px-4 text-sm sm:flex-none sm:text-base"
                >
                  <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate whitespace-nowrap font-black">
                    Room Code: {hostRoomCode}
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
                  disabled={!canPrepareMedia}
                  className="garden-button garden-button-secondary mt-4 h-14 w-full gap-2 px-5 text-base"
                >
                  <Mic className="h-5 w-5" aria-hidden="true" />
                  {isPreparingMedia
                    ? t(language, "preparingPermissions")
                    : isMediaReady
                      ? t(language, "permissionsReady")
                      : t(language, "allowPermissions")}
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
                          ref={localVideoRef}
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
                    {!isCameraEnabled ? (
                      <p className="garden-muted mt-2 text-center text-xs font-black">
                        {t(language, "startCameraOff")}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 grid gap-3">
                  <p className="garden-text-muted text-sm font-black">
                    {t(language, "mediaStartOptions")}
                  </p>
                  <div className="grid grid-cols-1 gap-3">
                    <button
                      type="button"
                      onClick={handleToggleMute}
                      disabled={isPreparingMedia}
                      className="garden-button garden-button-quiet h-14 gap-2 px-3 text-sm sm:text-base"
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
                    {videoCallingEnabled ? (
                      <button
                        type="button"
                        onClick={handleToggleCamera}
                        disabled={isPreparingMedia}
                        className="garden-button garden-button-quiet h-14 gap-2 px-3 text-sm sm:text-base"
                      >
                        {isCameraOnForControls ? (
                          <Camera className="h-5 w-5" aria-hidden="true" />
                        ) : (
                          <CameraOff className="h-5 w-5" aria-hidden="true" />
                        )}
                        {isCameraOnForControls
                          ? t(language, "startCameraOn")
                          : t(language, "startCameraOff")}
                      </button>
                    ) : null}
                  </div>
                </div>
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

              {isMediaReady ? (
                <section
                  aria-label={t(language, "callControls")}
                  className="garden-panel p-3"
                >
                  <button
                    type="button"
                    disabled={!canJoin}
                    onClick={() => void handleJoinCall()}
                    className="garden-button garden-button-primary h-16 w-full px-5 text-xl"
                  >
                    {t(language, "joinCall")}
                  </button>
                </section>
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
                      localVideoRef={localVideoRef}
                      remoteVideoRef={remoteVideoRef}
                      localScreenRef={localScreenRef}
                      remoteScreenRef={remoteScreenRef}
                      hasLocalVideo={isCameraEnabled}
                      hasRemoteVideo={hasRemoteVideo}
                      hasLocalScreenShare={isScreenSharing}
                      hasRemoteScreenShare={hasRemoteScreenShare}
                      isLocalSpeaking={isLocalSpeaking}
                      isRemoteSpeaking={isRemoteSpeaking}
                      localName={displayName}
                      dominantSurfaceId={resolvedDominantSurface}
                      smallSurfaceId={resolvedSmallSurface}
                      hasRemoteParticipant={Boolean(remoteDisplayName)}
                      onFullscreenSurface={handleEnterFullscreen}
                      onSelectSlot={handleSelectMediaSlot}
                      remoteName={remoteDisplayName || t(language, "remoteVideo")}
                      remoteStatus={remoteParticipantStatus}
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

                {renderConversationPanel()}
              </div>

              {activeControls}
            </>
          )}
        </section>
      </div>

      {fullscreenSurface && language ? (
        <section
          ref={fullscreenShellRef}
          className="media-fullscreen-shell"
          aria-label={t(language, "fullscreenSurface")}
        >
          <div className="media-fullscreen-stage">
            <VideoGrid
              language={language}
              localVideoRef={localVideoRef}
              remoteVideoRef={remoteVideoRef}
              localScreenRef={localScreenRef}
              remoteScreenRef={remoteScreenRef}
              hasLocalVideo={isCameraEnabled}
              hasRemoteVideo={hasRemoteVideo}
              hasLocalScreenShare={isScreenSharing}
              hasRemoteScreenShare={hasRemoteScreenShare}
              isLocalSpeaking={isLocalSpeaking}
              isRemoteSpeaking={isRemoteSpeaking}
              localName={displayName}
              dominantSurfaceId={fullscreenSurface}
              smallSurfaceId={null}
              hasRemoteParticipant={Boolean(remoteDisplayName)}
              onSelectSlot={() => openLayoutPicker("dominant")}
              remoteName={remoteDisplayName || t(language, "remoteVideo")}
              remoteStatus={remoteParticipantStatus}
            />
          </div>

          <div className="media-fullscreen-topbar">
            <button
              type="button"
              onClick={() => openLayoutPicker("dominant")}
              className="media-fullscreen-control"
            >
              <Pin className="h-4 w-4" aria-hidden="true" />
              <span>{t(language, "chooseDominantView")}</span>
            </button>
            {isConversationVisible ? (
              <button
                type="button"
                onClick={() =>
                  setIsFullscreenConversationExpanded((value) => !value)
                }
                className="media-fullscreen-control"
              >
                <Captions className="h-4 w-4" aria-hidden="true" />
                <span>
                  {isFullscreenConversationExpanded
                    ? t(language, "collapseConversationOverlay")
                    : t(language, "showConversationOverlay")}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleExitFullscreen}
              className="media-fullscreen-control"
            >
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
              <span>{t(language, "exitFullscreen")}</span>
            </button>
          </div>

          {isConversationVisible && isFullscreenConversationExpanded ? (
            <aside
              className="media-fullscreen-conversation"
              aria-label={t(language, "fullscreenConversation")}
            >
              {renderConversationPanel()}
            </aside>
          ) : isConversationVisible ? (
            <button
              type="button"
              onClick={() => setIsFullscreenConversationExpanded(true)}
              className="media-fullscreen-chat-pill"
            >
              <Captions className="h-4 w-4" aria-hidden="true" />
              <span>{t(language, "conversation")}</span>
            </button>
          ) : null}
        </section>
      ) : null}

      {showLayoutPicker && language ? (
        <div
          className="layout-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={() => setShowLayoutPicker(false)}
        >
          <section
            aria-labelledby="layout-modal-title"
            aria-modal="true"
            className="layout-modal w-full max-w-md overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="layout-modal-header">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <Pin className="h-4 w-4" aria-hidden="true" />
                  {t(language, "pinView")}
                </p>
                <h2 id="layout-modal-title" className="garden-title mt-1 text-2xl">
                  {layoutPickerTitle}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeLayoutPicker")}
                onClick={() => setShowLayoutPicker(false)}
                className="garden-icon-button grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="layout-modal-content">
              {layoutPickerMode !== "small" ? (
                <section className="layout-choice-group">
                  <h3>{t(language, "dominantView")}</h3>
                  <div className="layout-choice-list">
                    {layoutSurfaces.map((surface) => (
                      <button
                        key={`dominant-${surface.id}`}
                        type="button"
                        onClick={() => handleSelectDominantSurface(surface.id)}
                        className={`layout-choice-button ${
                          resolvedDominantSurface === surface.id
                            ? "is-selected"
                            : ""
                        }`}
                      >
                        <span>{surface.label}</span>
                        <small>{surface.status}</small>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {layoutPickerMode !== "dominant" ? (
                <section className="layout-choice-group">
                  <h3>{t(language, "smallView")}</h3>
                  <div className="layout-choice-list">
                    <button
                      type="button"
                      onClick={() => handleSelectSmallSurface(null)}
                      className={`layout-choice-button ${
                        resolvedSmallSurface ? "" : "is-selected"
                      }`}
                    >
                      <span>{t(language, "noSmallView")}</span>
                      <small>{t(language, "noSmallViewHelp")}</small>
                    </button>
                    {layoutSurfaces
                      .filter((surface) => surface.id !== resolvedDominantSurface)
                      .map((surface) => (
                        <button
                          key={`small-${surface.id}`}
                          type="button"
                          onClick={() => handleSelectSmallSurface(surface.id)}
                          className={`layout-choice-button ${
                            resolvedSmallSurface === surface.id
                              ? "is-selected"
                              : ""
                          }`}
                        >
                          <span>{surface.label}</span>
                          <small>{surface.status}</small>
                        </button>
                      ))}
                  </div>
                </section>
              ) : null}
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
              <section className="settings-modal-section">
                <p className="garden-text-muted text-sm font-black">
                  {t(language, "changeLanguage")}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {(["en", "ja"] as const).map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => handleLanguageSelect(code)}
                      className={`garden-button h-14 border px-4 text-lg ${
                        language === code
                          ? "garden-button-primary border-transparent"
                          : "garden-button-quiet"
                      }`}
                    >
                      {languageLabel(code)}
                    </button>
                  ))}
                </div>
              </section>

              {turnRelayPanel}
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
