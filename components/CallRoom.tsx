"use client";

import {
  ArrowLeft,
  Camera,
  CameraOff,
  Copy,
  Flower2,
  LogOut,
  Mic,
  MicOff,
  Settings
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageGate } from "@/components/LanguageGate";
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
import { getSavedRoomCodeForRoom } from "@/lib/roomCode";
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

type StopSubtitleServiceResponse =
  | { ok: true }
  | { ok: false; reason: "HOST_ONLY" | "RATE_LIMITED" };

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

const captionLogLimit = 60;
// Video calling is intentionally dormant for now. The WebRTC/video code remains
// in place so "enable video calling" can re-enable it by flipping this path.
const videoCallingEnabled = false;

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
    ...log.filter(
      (item) =>
        item.timestamp !== caption.timestamp || item.speakerId !== caption.speakerId
    ),
    caption
  ].slice(-captionLogLimit);
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
  const roomEndRedirectTimeoutRef = useRef<number | null>(null);
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
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [isRoomHost, setIsRoomHost] = useState(false);
  const [isSubtitleServiceStarted, setIsSubtitleServiceStarted] = useState(false);
  const [isStartingSubtitleService, setIsStartingSubtitleService] = useState(false);
  const [partialCaption, setPartialCaption] = useState<CaptionEvent | null>(null);
  const [finalCaption, setFinalCaption] = useState<CaptionEvent | null>(null);
  const [captionLog, setCaptionLog] = useState<CaptionEvent[]>([]);
  const [localPartialCaption, setLocalPartialCaption] =
    useState<CaptionEvent | null>(null);
  const [localFinalCaption, setLocalFinalCaption] =
    useState<CaptionEvent | null>(null);
  const [localCaptionLog, setLocalCaptionLog] = useState<CaptionEvent[]>([]);
  const [subtitleNoticeId, setSubtitleNoticeId] = useState(0);
  const [subtitleNoticeKey, setSubtitleNoticeKey] =
    useState<SubtitleNoticeKey>("subtitleServiceStartedNotice");
  const [showSubtitleNotice, setShowSubtitleNotice] = useState(false);

  const showSubtitleServiceBanner = useCallback((noticeKey: SubtitleNoticeKey) => {
    setSubtitleNoticeKey(noticeKey);
    setSubtitleNoticeId((value) => value + 1);
    setShowSubtitleNotice(true);
  }, []);

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
    if (!showSubtitleNotice) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowSubtitleNotice(false);
    }, 5000);

    return () => window.clearTimeout(timeout);
  }, [showSubtitleNotice, subtitleNoticeId]);

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
    return true;
  }, [roomId, socket]);

  const stopLocalSubtitleCapture = useCallback(() => {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    setPartialCaption(null);
    setLocalPartialCaption(null);
  }, []);

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

        if (rms > 0.025) {
          speakingFrames += 1;
          quietFrames = 0;
        } else {
          quietFrames += 1;
          speakingFrames = 0;
        }

        if (speakingFrames >= 2) {
          setSpeaking(true);
        }

        if (quietFrames >= 20) {
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

    function handleRoomEnded(payload?: { endedBy?: string }) {
      stopLocalSubtitleCapture();
      resetLocalMediaState();
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
      remoteStreamRef.current = null;
      setHasRemoteVideo(false);
      setRemoteDisplayName("");
      setCallState("disconnected");
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

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
        async (response: JoinResponse) => {
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
          if (response.otherParticipants.length > 0) {
            await createAndSendOffer();
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
    resetLocalMediaState,
    showSubtitleServiceBanner,
    startLocalSubtitleCapture,
    stopLocalSubtitleCapture
  ]);

  useEffect(() => {
    return () => {
      if (roomEndRedirectTimeoutRef.current !== null) {
        window.clearTimeout(roomEndRedirectTimeoutRef.current);
        roomEndRedirectTimeoutRef.current = null;
      }
      stopLocalSubtitleCapture();
      resetLocalMediaState();
      closePeerConnection(peerConnectionRef.current);
      if (socket.connected) {
        socket.emit("room:leave", {
          roomId,
          participantId: participantIdRef.current
        });
      }
    };
  }, [resetLocalMediaState, roomId, socket, stopLocalSubtitleCapture]);

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

    if (!videoCallingEnabled || startWithCameraOff) {
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

  function handleToggleSubtitleService() {
    if (!isRoomHost || isStartingSubtitleService) {
      return;
    }

    if (isSubtitleServiceStarted) {
      socket.emit(
        "subtitle:stop-service",
        {
          roomId,
          participantId: participantIdRef.current
        },
        (response: StopSubtitleServiceResponse) => {
          if (!response.ok) {
            setError(t(languageRef.current, "subtitleServiceUnavailable"));
            return;
          }

          setIsSubtitleServiceStarted(false);
          stopLocalSubtitleCapture();
        }
      );
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
          setError(t(languageRef.current, "subtitleServiceUnavailable"));
        }
      }
    );
  }

  function handleLeaveCall() {
    if (roomEndRedirectTimeoutRef.current !== null) {
      window.clearTimeout(roomEndRedirectTimeoutRef.current);
      roomEndRedirectTimeoutRef.current = null;
    }
    stopLocalSubtitleCapture();
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

    return roomInfo?.isCreator ? t(language, "roomSetup") : t(language, "joinCall");
  }, [callState, language, roomInfo?.isCreator]);

  const canEnterRoom =
    Boolean(language && roomInfo) &&
    (roomInfo?.isCreator || /^\d{4}$/.test(roomCode));
  const canPrepareMedia =
    callState === "idle" && Boolean(roomInfo) && !isPreparingMedia && !isMediaReady;
  const canJoin =
    callState === "idle" && canEnterRoom && isMediaReady && !isPreparingMedia;
  const isCameraOnForControls = isMediaReady ? isCameraEnabled : !startWithCameraOff;
  const hostRoomCode = roomInfo?.isCreator ? roomInfo.roomCode : undefined;
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
    <main
      className={`garden-scene safe-bottom min-h-dvh px-4 py-4 sm:px-6 lg:px-8 ${
        callState === "idle" ? "" : "pb-24"
      }`}
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
        className={`mx-auto grid w-full gap-3 overflow-hidden ${
          callState === "idle" ? "max-w-xl" : "max-w-5xl"
        } ${
          callState === "idle"
            ? "max-h-[calc(100dvh-2rem)]"
            : "call-shell-active max-h-[calc(100dvh-7rem)]"
        }`}
      >
        <section
          className={`grid min-h-0 min-w-0 gap-3 ${
            callState === "idle" ? "" : "call-active-layout"
          }`}
        >
          <header
            className={`garden-panel flex flex-wrap items-center justify-between gap-3 ${
              callState === "idle" ? "p-4 sm:p-5" : "p-3 sm:p-4"
            }`}
          >
            <div className="min-w-0 flex-1">
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
            <div
              className={`flex min-w-0 shrink-0 items-center gap-2 ${
                hostRoomCode ? "max-sm:w-full" : ""
              }`}
            >
              {hostRoomCode ? (
                <button
                  type="button"
                  aria-label={isCodeCopied ? t(language, "copied") : t(language, "copyRoomCode")}
                  title={isCodeCopied ? t(language, "copied") : t(language, "copyRoomCode")}
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
                      {isMuted ? t(language, "startMuted") : t(language, "startUnmuted")}
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
              <VideoGrid
                language={language}
                localVideoRef={localVideoRef}
                remoteVideoRef={remoteVideoRef}
                hasLocalVideo={videoCallingEnabled && isCameraEnabled}
                hasRemoteVideo={videoCallingEnabled && hasRemoteVideo}
                isLocalSpeaking={isLocalSpeaking}
                localName={displayName}
                localAction={
                  <button
                    type="button"
                    onClick={handleToggleMute}
                    className="garden-button garden-button-quiet h-11 gap-2 px-3 text-sm"
                  >
                    {isMuted ? (
                      <MicOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Mic className="h-4 w-4" aria-hidden="true" />
                    )}
                    <span className="font-black">
                      {isMuted ? t(language, "unmute") : t(language, "mute")}
                    </span>
                  </button>
                }
                hasRemoteParticipant={Boolean(remoteDisplayName)}
                remoteName={remoteDisplayName || t(language, "remoteVideo")}
                remoteStatus={remoteParticipantStatus}
              />

              {isRoomHost ? (
                <section
                  aria-label={t(language, "callControls")}
                  className="garden-panel grid gap-2 p-2 sm:p-3"
                >
                  <button
                    type="button"
                    onClick={handleToggleSubtitleService}
                    disabled={isStartingSubtitleService}
                    className={`garden-button h-12 px-4 text-base ${
                      isSubtitleServiceStarted
                        ? "garden-button-danger"
                        : "garden-button-primary"
                    }`}
                  >
                    {isStartingSubtitleService
                      ? t(language, "subtitleServiceStarting")
                      : isSubtitleServiceStarted
                        ? t(language, "stopSubtitleService")
                        : t(language, "startSubtitleService")}
                  </button>
                </section>
              ) : null}

              <section className="garden-panel subtitle-focus-card grid min-h-0 gap-3 p-3 sm:p-4">
                <SubtitlesPanel
                  language={language}
                  partialCaption={partialCaption}
                  finalCaption={finalCaption}
                  captionLog={captionLog}
                  embedded
                />

                <SubtitlesPanel
                  language={language}
                  title={t(language, "subtitlePreview")}
                  emptyText={t(language, "noSubtitlePreviewYet")}
                  partialCaption={localPartialCaption}
                  finalCaption={localFinalCaption}
                  captionLog={localCaptionLog}
                  isPreview
                  embedded
                />
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

              {videoCallingEnabled ? (
                <section
                  aria-label={t(language, "callControls")}
                  className="garden-panel grid grid-cols-2 gap-3 p-3"
                >
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
                </section>
              ) : null}
            </>
          )}
        </section>

      </div>

      {callState !== "idle" ? (
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-6 lg:px-8">
          <div className="mx-auto max-w-5xl">
            <button
              type="button"
              onClick={handleLeaveCall}
              className="garden-button garden-leave-bar h-14 w-full gap-2 px-5 text-lg"
            >
              <LogOut className="h-5 w-5" aria-hidden="true" />
              {t(language, "leaveCall")}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
