"use client";

import {
  ArrowLeft,
  Camera,
  CameraOff,
  Flower2,
  LogOut,
  Mic,
  MicOff,
  Settings
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageGate } from "@/components/LanguageGate";
import { RoomCodeModal } from "@/components/RoomCodeModal";
import { CaptionEvent, SubtitlesPanel } from "@/components/SubtitlesPanel";
import { UsernameGate } from "@/components/UsernameGate";
import { VideoGrid } from "@/components/VideoGrid";
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
  t
} from "@/lib/i18n";
import { buildInviteUrl } from "@/lib/invite";
import { getSocket } from "@/lib/socket";
import {
  addStreamTracks,
  closePeerConnection,
  createPeerConnection
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
    }
  | {
      ok: false;
      reason:
        | "ROOM_NOT_FOUND"
        | "INVALID_CODE"
        | "TOO_MANY_ATTEMPTS"
        | "ROOM_FULL"
        | "INVALID_LANGUAGE";
      blockedUntil?: number;
    };

type JoinFailureReason = Extract<JoinResponse, { ok: false }>["reason"];

type StartSubtitleServiceResponse =
  | { ok: true }
  | { ok: false; reason: "HOST_ONLY" | "RATE_LIMITED" | "NOT_CONFIGURED" };

type CallState =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "disconnected";

const captionLogLimit = 60;

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

  if (reason === "INVALID_LANGUAGE") {
    return t(language, "invalidLanguage");
  }

  return t(language, "roomNotFound");
}

function hasLiveAudioTrack(stream: MediaStream | null): stream is MediaStream {
  return (
    stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false
  );
}

function appendCaptionLog(log: CaptionEvent[], caption: CaptionEvent) {
  return [
    caption,
    ...log.filter(
      (item) =>
        item.timestamp !== caption.timestamp || item.speakerId !== caption.speakerId
    )
  ].slice(0, captionLogLimit);
}

export function CallRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const socket = useMemo(() => getSocket(), []);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const audioCaptureRef = useRef<AudioCaptureController | null>(null);
  const audioEnhancementStopRef = useRef<(() => void) | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string>("");
  const roomCodeRef = useRef("");
  const languageRef = useRef<Language>("en");
  const displayNameRef = useRef("");
  const speakingMonitorRef = useRef<{
    analyser: AnalyserNode;
    audioContext: AudioContext;
    frameId: number;
    source: MediaStreamAudioSourceNode;
  } | null>(null);
  const isLocalSpeakingRef = useRef(false);

  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [remoteDisplayName, setRemoteDisplayName] = useState("");
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [copiedTarget, setCopiedTarget] = useState<"invite" | "code" | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [startWithCameraOff, setStartWithCameraOff] = useState(false);
  const [isPreparingMedia, setIsPreparingMedia] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [isRoomHost, setIsRoomHost] = useState(false);
  const [isSubtitleServiceStarted, setIsSubtitleServiceStarted] = useState(false);
  const [isStartingSubtitleService, setIsStartingSubtitleService] = useState(false);
  const [isSubtitleCaptureActive, setIsSubtitleCaptureActive] = useState(false);
  const [partialCaption, setPartialCaption] = useState<CaptionEvent | null>(null);
  const [finalCaption, setFinalCaption] = useState<CaptionEvent | null>(null);
  const [captionLog, setCaptionLog] = useState<CaptionEvent[]>([]);
  const [localPartialCaption, setLocalPartialCaption] =
    useState<CaptionEvent | null>(null);
  const [localFinalCaption, setLocalFinalCaption] =
    useState<CaptionEvent | null>(null);
  const [localCaptionLog, setLocalCaptionLog] = useState<CaptionEvent[]>([]);

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
    setInviteUrl(buildInviteUrl(roomId));
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
          credentials: "include"
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
        spokenLanguage: language
      });

      if (socket.connected) {
        socket.emit("participant:language", {
          roomId,
          participantId: participantIdRef.current,
          spokenLanguage: language
        });
      }
    }
  }, [language, roomId, socket]);

  useEffect(() => {
    const localVideo = localVideoRef.current;
    if (localVideo && localStreamRef.current) {
      localVideo.srcObject = localStreamRef.current;
    }
  }, [callState, isCameraEnabled]);

  useEffect(() => {
    const remoteVideo = remoteVideoRef.current;
    if (remoteVideo && remoteStreamRef.current) {
      remoteVideo.srcObject = remoteStreamRef.current;
    }
  }, [callState, hasRemoteVideo]);

  const ensurePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = createPeerConnection();
    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }

    if (localStreamRef.current) {
      addStreamTracks(peerConnection, localStreamRef.current);
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc:ice-candidate", {
          roomId,
          from: participantIdRef.current,
          candidate: event.candidate
        });
      }
    };

    peerConnection.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        remoteStream.addTrack(track);
      }

      setHasRemoteVideo(
        remoteStream.getVideoTracks().some((track) => track.readyState === "live")
      );
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
  }, [roomId, socket]);

  const createAndSendOffer = useCallback(async () => {
    const peerConnection = ensurePeerConnection();

    if (peerConnection.signalingState !== "stable") {
      return;
    }

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await peerConnection.setLocalDescription(offer);

    socket.emit("webrtc:offer", {
      roomId,
      from: participantIdRef.current,
      description: peerConnection.localDescription
    });
  }, [ensurePeerConnection, roomId, socket]);

  const startLocalSubtitleCapture = useCallback(async () => {
    if (audioCaptureRef.current) {
      setIsSubtitleCaptureActive(true);
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
        spokenLanguage: languageRef.current
      },
      onSegment: (metadata, segment) => {
        socket.emit("audio:segment", {
          ...metadata,
          audio: segment.audio,
          isFinal: segment.isFinal,
          clientSegmentId: segment.clientSegmentId
        });
      }
    });
    await audioCaptureRef.current.start();
    setIsSubtitleCaptureActive(true);
    return true;
  }, [roomId, socket]);

  const stopLocalSpeakingMonitor = useCallback(() => {
    const monitor = speakingMonitorRef.current;

    if (monitor) {
      window.cancelAnimationFrame(monitor.frameId);
      monitor.source.disconnect();
      monitor.analyser.disconnect();
      void monitor.audioContext.close().catch(() => undefined);
      speakingMonitorRef.current = null;
    }

    isLocalSpeakingRef.current = false;
    setIsLocalSpeaking(false);
  }, []);

  const startLocalSpeakingMonitor = useCallback(
    (stream: MediaStream) => {
      stopLocalSpeakingMonitor();

      const AudioContextConstructor =
        window.AudioContext ??
        (window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;

      if (!AudioContextConstructor || stream.getAudioTracks().length === 0) {
        return;
      }

      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      let speakingFrames = 0;
      let quietFrames = 0;

      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const samples = new Uint8Array(analyser.fftSize);
      source.connect(analyser);
      void audioContext.resume().catch(() => undefined);

      function setSpeaking(nextValue: boolean) {
        if (isLocalSpeakingRef.current === nextValue) {
          return;
        }

        isLocalSpeakingRef.current = nextValue;
        setIsLocalSpeaking(nextValue);
      }

      function tick() {
        analyser.getByteTimeDomainData(samples);

        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }

        const rms = Math.sqrt(sum / samples.length);

        if (rms > 0.035) {
          speakingFrames += 1;
          quietFrames = 0;
        } else {
          quietFrames += 1;
          speakingFrames = 0;
        }

        if (speakingFrames >= 2) {
          setSpeaking(true);
        }

        if (quietFrames >= 12) {
          setSpeaking(false);
        }

        const currentMonitor = speakingMonitorRef.current;
        if (currentMonitor) {
          currentMonitor.frameId = window.requestAnimationFrame(tick);
        }
      }

      speakingMonitorRef.current = {
        analyser,
        audioContext,
        frameId: window.requestAnimationFrame(tick),
        source
      };
    },
    [stopLocalSpeakingMonitor]
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
    localStreamRef.current = null;
    setIsMediaReady(false);
    setIsCameraEnabled(false);
  }, [stopLocalMediaTracks, stopLocalSpeakingMonitor]);

  useEffect(() => {
    function handlePeerJoined(payload: { displayName?: string }) {
      setRemoteDisplayName(payload.displayName ?? "");
      void createAndSendOffer();
      setCallState("connecting");
    }

    async function handleOffer(payload: {
      description: RTCSessionDescriptionInit;
      from: string;
    }) {
      const peerConnection = ensurePeerConnection();
      await peerConnection.setRemoteDescription(payload.description);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("webrtc:answer", {
        roomId,
        from: participantIdRef.current,
        description: peerConnection.localDescription
      });
    }

    async function handleAnswer(payload: {
      description: RTCSessionDescriptionInit;
    }) {
      const peerConnection = ensurePeerConnection();

      if (peerConnection.signalingState !== "stable") {
        await peerConnection.setRemoteDescription(payload.description);
      }
    }

    async function handleIceCandidate(payload: { candidate: RTCIceCandidateInit }) {
      const peerConnection = ensurePeerConnection();
      await peerConnection.addIceCandidate(payload.candidate).catch(() => undefined);
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
      setIsSubtitleCaptureActive(false);
      setError(t(languageRef.current, "subtitleServiceUnavailable"));
    }

    async function handleSubtitleServiceStarted() {
      setIsSubtitleServiceStarted(true);
      const started = await startLocalSubtitleCapture();

      if (!started) {
        setIsSubtitleCaptureActive(false);
        setError(t(languageRef.current, "subtitleServiceUnavailable"));
      }
    }

    function handlePeerLeft() {
      setHasRemoteVideo(false);
      setRemoteDisplayName("");
      setCallState("waiting");
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    }

    function handleReconnectAttempt() {
      setCallState("reconnecting");
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
          displayName: displayNameRef.current,
          spokenLanguage: languageRef.current
        },
        (response: JoinResponse) => {
          if (!response.ok) {
            setError(errorForJoinReason(languageRef.current, response.reason));
            return;
          }

          setIsRoomHost(response.isCreator);
          setIsSubtitleServiceStarted(response.subtitleServiceStarted);
          setRemoteDisplayName(response.otherParticipants[0]?.displayName ?? "");
          if (response.subtitleServiceStarted) {
            void startLocalSubtitleCapture();
          }
        }
      );
    }

    socket.on("peer:joined", handlePeerJoined);
    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    socket.on("caption", handleCaption);
    socket.on("caption:preview", handleCaptionPreview);
    socket.on("caption:error", handleCaptionError);
    socket.on("subtitle:service-started", handleSubtitleServiceStarted);
    socket.on("peer:left", handlePeerLeft);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);

    return () => {
      socket.off("peer:joined", handlePeerJoined);
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:answer", handleAnswer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
      socket.off("caption", handleCaption);
      socket.off("caption:preview", handleCaptionPreview);
      socket.off("caption:error", handleCaptionError);
      socket.off("subtitle:service-started", handleSubtitleServiceStarted);
      socket.off("peer:left", handlePeerLeft);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
    };
  }, [
    callState,
    createAndSendOffer,
    ensurePeerConnection,
    roomId,
    socket,
    startLocalSubtitleCapture
  ]);

  useEffect(() => {
    return () => {
      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;
      resetLocalMediaState();
      closePeerConnection(peerConnectionRef.current);
      if (socket.connected) {
        socket.emit("room:leave", {
          roomId,
          participantId: participantIdRef.current
        });
      }
    };
  }, [resetLocalMediaState, roomId, socket]);

  async function requestMedia() {
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
          autoGainControl: true
        },
        video: false
      });
    } catch (mediaError) {
      throw new Error(
        mediaError instanceof DOMException && mediaError.name === "NotAllowedError"
          ? "microphone-denied"
          : "microphone-unavailable"
      );
    }

    const enhancedMicrophone = await createEnhancedMicrophoneStream(audioStream);
    audioEnhancementStopRef.current = enhancedMicrophone.stop;
    const combinedStream = new MediaStream(
      enhancedMicrophone.stream.getAudioTracks()
    );

    for (const track of combinedStream.getAudioTracks()) {
      track.enabled = !isMuted;
    }

    if (startWithCameraOff) {
      setIsCameraEnabled(false);
      setCameraError("");
    } else {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "user",
            width: { ideal: 960 },
            height: { ideal: 720 }
          }
        });

        for (const track of videoStream.getVideoTracks()) {
          combinedStream.addTrack(track);
        }
        setIsCameraEnabled(true);
        setCameraError("");
      } catch (mediaError) {
        setIsCameraEnabled(false);
        setCameraError(
          mediaError instanceof DOMException && mediaError.name === "NotAllowedError"
            ? t(languageRef.current, "cameraPermissionDenied")
            : t(languageRef.current, "cameraUnavailable")
        );
      }
    }

    localStreamRef.current = combinedStream;
    startLocalSpeakingMonitor(combinedStream);
    setIsMediaReady(true);

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = combinedStream;
    }

    return combinedStream;
  }

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

  async function handleJoinCall() {
    if (!language || !roomInfo) {
      return;
    }

    setError("");
    setCallState("connecting");

    let stream = localStreamRef.current;
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
        displayName,
        spokenLanguage: language
      },
      async (response: JoinResponse) => {
        if (!response.ok) {
          setCallState("idle");
          setError(errorForJoinReason(language, response.reason));
          resetLocalMediaState();
          return;
        }

        const peerConnection = ensurePeerConnection();
        addStreamTracks(peerConnection, streamForJoin);
        setIsRoomHost(response.isCreator);
        setIsSubtitleServiceStarted(response.subtitleServiceStarted);
        setRemoteDisplayName(response.otherParticipants[0]?.displayName ?? "");

        setCallState(
          response.otherParticipants.length > 0 ? "connecting" : "waiting"
        );

        if (response.subtitleServiceStarted) {
          await startLocalSubtitleCapture();
        }

        if (response.otherParticipants.length > 0) {
          await createAndSendOffer();
        }
      }
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

  async function handleCopyInvite() {
    await navigator.clipboard.writeText(inviteUrl || buildInviteUrl(roomId));
    setCopiedTarget("invite");
    window.setTimeout(() => setCopiedTarget(null), 1600);
  }

  async function handleCopyCode() {
    if (!roomInfo?.roomCode) {
      return;
    }

    await navigator.clipboard.writeText(roomInfo.roomCode);
    setCopiedTarget("code");
    window.setTimeout(() => setCopiedTarget(null), 1600);
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
      setStartWithCameraOff((value) => !value);
      return;
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      const nextEnabled = !isCameraEnabled;
      for (const track of videoTracks) {
        track.enabled = nextEnabled;
      }
      setIsCameraEnabled(nextEnabled);
      return;
    }

    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" }
      });
      const [track] = videoStream.getVideoTracks();

      if (!track) {
        return;
      }

      stream.addTrack(track);
      if (callState !== "idle") {
        const peerConnection = ensurePeerConnection();
        peerConnection.addTrack(track, stream);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setIsCameraEnabled(true);
      setCameraError("");
    } catch {
      setCameraError(t(languageRef.current, "cameraPermissionDenied"));
    }
  }

  function handleStartSubtitleService() {
    if (!isRoomHost || isSubtitleServiceStarted || isStartingSubtitleService) {
      return;
    }

    setIsStartingSubtitleService(true);
    socket.emit(
      "subtitle:start-service",
      {
        roomId,
        participantId: participantIdRef.current
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
          setIsSubtitleCaptureActive(false);
          setError(t(languageRef.current, "subtitleServiceUnavailable"));
        }
      }
    );
  }

  function handleLeaveCall() {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    setIsSubtitleCaptureActive(false);
    resetLocalMediaState();
    closePeerConnection(peerConnectionRef.current);
    peerConnectionRef.current = null;
    socket.emit("room:leave", {
      roomId,
      participantId: participantIdRef.current
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

    return t(language, "roomSetup");
  }, [callState, language]);

  const canEnterRoom =
    Boolean(language && roomInfo) &&
    (roomInfo?.isCreator || /^\d{4}$/.test(roomCode));
  const canPrepareMedia =
    callState === "idle" && Boolean(roomInfo) && !isPreparingMedia && !isMediaReady;
  const canJoin =
    callState === "idle" && canEnterRoom && isMediaReady && !isPreparingMedia;
  const isCameraOnForControls = isMediaReady ? isCameraEnabled : !startWithCameraOff;
  const showRoomSetup = callState === "idle" || Boolean(roomInfo?.isCreator);
  const showSubtitlePreview =
    callState !== "idle" && (isSubtitleServiceStarted || isSubtitleCaptureActive);
  const subtitleStatusText = useMemo(() => {
    if (!language) {
      return "";
    }

    if (isStartingSubtitleService) {
      return t(language, "subtitleServiceStarting");
    }

    if (isSubtitleCaptureActive) {
      return t(language, "subtitleServiceOn");
    }

    if (isSubtitleServiceStarted) {
      return t(language, "subtitleServiceStarting");
    }

    return t(language, "subtitleServiceWaiting");
  }, [
    isStartingSubtitleService,
    isSubtitleCaptureActive,
    isSubtitleServiceStarted,
    language
  ]);
  const remoteParticipantStatus = useMemo(() => {
    if (!language) {
      return "";
    }

    if (callState === "waiting") {
      return t(language, "waitingForOther");
    }

    if (callState === "connected" && !hasRemoteVideo) {
      return t(language, "audioOnly");
    }

    if (hasRemoteVideo) {
      return t(language, "cameraOn");
    }

    return statusText;
  }, [callState, hasRemoteVideo, language, statusText]);

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
    <main className="garden-scene safe-bottom min-h-dvh px-4 py-4 sm:px-6 lg:px-8">
      <div
        className={`mx-auto grid w-full gap-4 ${
          callState === "idle"
            ? "max-w-xl"
            : "max-w-7xl lg:grid-cols-[minmax(0,1fr)_18rem]"
        }`}
      >
        <section
          className={`grid min-w-0 gap-4 ${
            callState === "idle" ? "" : "content-start lg:min-h-[calc(100dvh-2rem)]"
          }`}
        >
          <header
            className={`garden-panel flex items-center justify-between gap-4 ${
              callState === "idle" ? "p-4 sm:p-5" : "p-3 sm:p-4"
            }`}
          >
            <div className="min-w-0">
              <p className="garden-kicker flex items-center gap-2">
                <Flower2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
                {t(language, "appName")}
              </p>
              <p
                className={`garden-title mt-2 ${
                  callState === "idle" ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"
                }`}
              >
                {statusText}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                aria-label={t(language, "back")}
                onClick={handleBackToHome}
                className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={
                  showSettings
                    ? t(language, "closeSettings")
                    : t(language, "openSettings")
                }
                onClick={() => setShowSettings((value) => !value)}
                className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
              >
                <Settings className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </header>

          {showSettings ? (
            <section className="garden-panel p-4">
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
          ) : null}

          {callState === "idle" ? (
            <>
              <RoomCodeModal
                language={language}
                roomCode={roomInfo?.roomCode}
                inviteUrl={inviteUrl}
                codeValue={roomCode}
                isCreator={Boolean(roomInfo?.isCreator)}
                copiedTarget={copiedTarget}
                onCodeChange={setRoomCode}
                onCopyInvite={handleCopyInvite}
                onCopyCode={handleCopyCode}
              />

              <section className="garden-panel p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
                    {isMediaReady ? (
                      <Camera className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <Mic className="h-5 w-5" aria-hidden="true" />
                    )}
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
                  {isMediaReady ? (
                    <Camera className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <Mic className="h-5 w-5" aria-hidden="true" />
                  )}
                  {isPreparingMedia
                    ? t(language, "preparingPermissions")
                    : isMediaReady
                      ? t(language, "permissionsReady")
                      : t(language, "allowPermissions")}
                </button>
                <div className="mt-4 grid gap-3">
                  <p className="garden-text-muted text-sm font-black">
                    {t(language, "mediaStartOptions")}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
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
                      {isMuted ? t(language, "startMuted") : t(language, "startUnmuted")}
                    </button>
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

              <section
                aria-label={t(language, "callControls")}
                className="garden-panel p-3"
              >
                <button
                  type="button"
                  disabled={!canJoin}
                  onClick={handleJoinCall}
                  className="garden-button garden-button-primary h-16 w-full px-5 text-xl"
                >
                  {t(language, "joinCall")}
                </button>
              </section>
            </>
          ) : (
            <>
              <VideoGrid
                language={language}
                localVideoRef={localVideoRef}
                remoteVideoRef={remoteVideoRef}
                hasLocalVideo={isCameraEnabled}
                hasRemoteVideo={hasRemoteVideo}
                isLocalSpeaking={isLocalSpeaking}
                localName={displayName}
                remoteName={remoteDisplayName || t(language, "remoteVideo")}
                remoteStatus={remoteParticipantStatus}
              />

              <SubtitlesPanel
                language={language}
                partialCaption={partialCaption}
                finalCaption={finalCaption}
                captionLog={captionLog}
              />

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

              <section
                aria-label={t(language, "callControls")}
                className="garden-panel grid grid-cols-2 gap-3 p-3"
              >
                {isRoomHost && !isSubtitleServiceStarted ? (
                  <button
                    type="button"
                    onClick={handleStartSubtitleService}
                    disabled={isStartingSubtitleService}
                    className="garden-button garden-button-primary col-span-2 h-14 px-5 text-lg"
                  >
                    {t(language, "startSubtitleService")}
                  </button>
                ) : null}
                {isSubtitleServiceStarted || isStartingSubtitleService ? (
                  <p className="garden-status-soft col-span-2 rounded-lg px-4 py-3 text-center text-sm font-black">
                    {subtitleStatusText}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="garden-button garden-button-quiet h-14 gap-2 px-4 text-base"
                >
                  {isMuted ? (
                    <MicOff className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <Mic className="h-5 w-5" aria-hidden="true" />
                  )}
                  {isMuted ? t(language, "unmute") : t(language, "mute")}
                </button>
                <button
                  type="button"
                  onClick={handleToggleCamera}
                  className="garden-button garden-button-quiet h-14 gap-2 px-4 text-base"
                >
                  {isCameraEnabled ? (
                    <Camera className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <CameraOff className="h-5 w-5" aria-hidden="true" />
                  )}
                  {isCameraEnabled
                    ? t(language, "cameraOn")
                    : t(language, "cameraOff")}
                </button>
                <button
                  type="button"
                  onClick={handleLeaveCall}
                  className="garden-button garden-button-danger col-span-2 h-14 gap-2 px-5 text-lg"
                >
                  <LogOut className="h-5 w-5" aria-hidden="true" />
                  {t(language, "leaveCall")}
                </button>
              </section>
            </>
          )}
        </section>

        {callState !== "idle" && (showRoomSetup || showSubtitlePreview) ? (
          <aside className="order-last grid gap-4 lg:order-none lg:sticky lg:top-4 lg:self-start">
            {showRoomSetup ? (
              <RoomCodeModal
                language={language}
                roomCode={roomInfo?.roomCode}
                inviteUrl={inviteUrl}
                codeValue={roomCode}
                isCreator={Boolean(roomInfo?.isCreator)}
                copiedTarget={copiedTarget}
                onCodeChange={setRoomCode}
                onCopyInvite={handleCopyInvite}
                onCopyCode={handleCopyCode}
              />
            ) : null}
            {showSubtitlePreview ? (
              <SubtitlesPanel
                language={language}
                title={t(language, "subtitlePreview")}
                emptyText={t(language, "noSubtitlePreviewYet")}
                partialCaption={localPartialCaption}
                finalCaption={localFinalCaption}
                captionLog={localCaptionLog}
                isPreview
                showOriginalText
              />
            ) : null}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
