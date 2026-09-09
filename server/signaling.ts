import { randomUUID } from "node:crypto";
import { chatTextLimit, chatLogLimit, fileSizeLimit, type ChatMessage } from "../lib/chat";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { isSupportedLanguage } from "../lib/i18n";
import type { Language } from "../lib/i18n";
import {
  isTranscriptionConfigured
} from "../lib/transcription";
import { parseAudioSegment, processCaptionSegment, captionProviders } from "./captions";
import { parseCookies } from "./cookies";
import { isAllowedOrigin } from "./origin";
import { consumeJoinAttempt, createRateLimiter, requestIp } from "./requestSafety";
import {
  creatorCookieName,
  expireDisconnectedParticipant,
  findParticipantBySocket,
  getRoom,
  isCreatorSecret,
  joinRoom,
  leaveRoom,
  markParticipantDisconnected,
  maxRoomParticipants,
  Participant,
  Room,
  participantReconnectTtlMs,
  startScreenShare,
  startSubtitleService,
  stopScreenShare,
  stopSubtitleService,
  updateParticipantLanguage
} from "./rooms";

type CaptionEvent = {
  roomId: string;
  speakerId: string;
  originalLanguage: Language;
  originalText: string;
  translatedLanguage: Language;
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
};

type SocketParticipantSession = {
  roomId: string;
  participantId: string;
};

const socketParticipantSessions = new Map<string, SocketParticipantSession>();
const disconnectExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function disconnectExpiryKey(roomId: string, participantId: string) {
  return `${roomId}:${participantId}`;
}

function clearDisconnectExpiry(roomId: string, participantId: string) {
  const key = disconnectExpiryKey(roomId, participantId);
  const timer = disconnectExpiryTimers.get(key);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  disconnectExpiryTimers.delete(key);
}

function clearRoomDisconnectExpiries(roomId: string) {
  const prefix = `${roomId}:`;

  for (const [key, timer] of disconnectExpiryTimers) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    clearTimeout(timer);
    disconnectExpiryTimers.delete(key);
  }
}

function acknowledge(callback: unknown, payload: unknown) {
  if (typeof callback === "function") callback(payload);
}

function emitRoomStatus(io: Server, roomId: string) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  io.to(roomId).emit("room:status", {
    maxParticipants: room.maxParticipants,
    participantCount: room.participants.size
  });
}

function emitToOtherParticipants(
  io: Server,
  roomId: string,
  participantId: string,
  event: string,
  payload: unknown
) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  for (const participant of room.participants.values()) {
    if (participant.participantId !== participantId && participant.socketId) {
      io.to(participant.socketId).emit(event, payload);
    }
  }
}

function emitToParticipant(
  io: Server,
  roomId: string,
  participantId: string,
  event: string,
  payload: unknown
) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!participant?.socketId) {
    return false;
  }

  io.to(participant.socketId).emit(event, payload);
  return true;
}

function emitRoomEnded(io: Server, roomId: string, endedBy: string) {
  io.to(roomId).emit("room:ended", {
    roomId,
    endedBy
  });
  void io.in(roomId).socketsLeave(roomId);
}

function scheduleDisconnectExpiry(
  io: Server,
  roomId: string,
  participantId: string
) {
  clearDisconnectExpiry(roomId, participantId);

  const key = disconnectExpiryKey(roomId, participantId);
  const timer = setTimeout(() => {
    disconnectExpiryTimers.delete(key);
    const roomBeforeExpire = getRoom(roomId);
    const wasScreenSharing =
      roomBeforeExpire?.activeScreenShareParticipantId === participantId;
    const result = expireDisconnectedParticipant(roomId, participantId);

    if (!result.expired || !result.participant) {
      return;
    }

    if (result.roomEnded) {
      emitRoomEnded(io, roomId, participantId);
      clearRoomDisconnectExpiries(roomId);
      return;
    }

    if (wasScreenSharing) {
      emitToOtherParticipants(io, roomId, participantId, "media:screen-stopped", {
        from: participantId,
        roomId
      });
    }

    emitToOtherParticipants(io, roomId, participantId, "peer:left", {
      participantId
    });
    emitRoomStatus(io, roomId);
  }, participantReconnectTtlMs);

  timer.unref?.();
  disconnectExpiryTimers.set(key, timer);
}

function getSocketParticipant(socketId: string) {
  const session = socketParticipantSessions.get(socketId);
  const room = session ? getRoom(session.roomId) : undefined;
  const participant = session
    ? room?.participants.get(session.participantId)
    : undefined;

  if (!session || !room || !participant || participant.socketId !== socketId) {
    socketParticipantSessions.delete(socketId);
    return null;
  }

  return { room, participant, session };
}

function publicParticipant(participant: Participant) {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    spokenLanguage: participant.spokenLanguage,
    isHost: participant.isHost,
    joinedAt: participant.joinedAt,
    lastSeenAt: participant.lastSeenAt
  };
}

export function isAuthorizedPeerTarget({
  room,
  senderParticipantId,
  toParticipantId
}: {
  room: Room;
  senderParticipantId: string;
  toParticipantId: unknown;
}) {
  const normalizedTargetId =
    typeof toParticipantId === "string" ? toParticipantId : "";
  const sender = room.participants.get(senderParticipantId);
  const target = room.participants.get(normalizedTargetId);

  return Boolean(
    normalizedTargetId &&
      sender?.socketId &&
      target?.socketId &&
      normalizedTargetId !== senderParticipantId
  );
}

function emitAuthorizedPeerEvent(
  io: Server,
  socketId: string,
  event: string,
  payload: Record<string, unknown>
) {
  const match = getSocketParticipant(socketId);
  const toParticipantId =
    typeof payload.toParticipantId === "string" ? payload.toParticipantId : "";

  if (
    !match ||
    !isAuthorizedPeerTarget({
      room: match.room,
      senderParticipantId: match.participant.participantId,
      toParticipantId
    })
  ) {
    return;
  }

  emitToParticipant(
    io,
    match.room.roomId,
    toParticipantId,
    event,
    {
      ...payload,
      roomId: match.room.roomId,
      from: match.participant.participantId
    }
  );
}

function buildCaption({
  roomId,
  speaker,
  originalText,
  translatedLanguage,
  translatedText,
  isFinal,
  timestamp
}: {
  roomId: string;
  speaker: Participant;
  originalText: string;
  translatedLanguage: Language;
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
}): CaptionEvent {
  return {
    roomId,
    speakerId: speaker.participantId,
    originalLanguage: speaker.spokenLanguage,
    originalText,
    translatedLanguage,
    translatedText,
    isFinal,
    timestamp
  };
}

export function createSignalingServer(httpServer: HttpServer, providers = captionProviders) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
      },
      credentials: true
    },
    allowRequest: (request, callback) => {
      callback(null, isAllowedOrigin(request.headers.origin));
    },
    maxHttpBufferSize: 1_000_000
  });

  const recentChats = new WeakMap<Room, Map<string, ChatMessage>>();
  io.on("connection", (socket) => {
    const consumeChat = createRateLimiter(30, 60_000);
    let activeChatTranslations = 0;
    let connectionAbort = new AbortController();
    let segmentSequence = 0;
    let lastPreviewSequence = 0;
    const lastTranslationSequence = new Map<Language, number>();
    let activeSegments = 0;
    const seenSegments = new Set<string>();
    const consumeAudio = createRateLimiter(40, 60_000);
    const consumeSubtitleControl = createRateLimiter(16, 60_000);
    socket.on("room:join", (payload, callback) => {
      if (!consumeJoinAttempt(requestIp(socket.request))) {
        acknowledge(callback, { ok: false, reason: "TOO_MANY_ATTEMPTS" });
        return;
      }

      const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
      const participantId = typeof payload?.participantId === "string" ? payload.participantId : "";
      const existingSession = socketParticipantSessions.get(socket.id);
      if (!/^[a-f0-9]{6}$/i.test(roomId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(participantId) ||
          (existingSession && (existingSession.roomId !== roomId || existingSession.participantId !== participantId))) {
        acknowledge(callback, { ok: false, reason: "INVALID_SESSION" });
        return;
      }
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const isCreator = isCreatorSecret(
        roomId,
        cookies[creatorCookieName(roomId)]
      );

      const result = joinRoom({
        roomId,
        participantId,
        displayName: payload?.displayName,
        spokenLanguage: payload?.spokenLanguage,
        roomCode: typeof payload?.roomCode === "string" ? payload.roomCode : "",
        participantSessionToken: payload?.participantSessionToken,
        socketId: socket.id,
        isCreator
      });

      if (!result.ok) {
        acknowledge(callback, result);
        return;
      }

      if (connectionAbort.signal.aborted) connectionAbort = new AbortController();
      socket.join(roomId);
      clearDisconnectExpiry(roomId, participantId);
      socketParticipantSessions.set(socket.id, {
        roomId,
        participantId
      });
      acknowledge(callback, {
        ok: true,
        participant: publicParticipant(result.participant),
        otherParticipants: result.otherParticipants.map(publicParticipant),
        activeScreenShareParticipantId: getRoom(roomId)?.activeScreenShareParticipantId,
        maxParticipants: getRoom(roomId)?.maxParticipants ?? maxRoomParticipants,
        participantCount: result.participantCount,
        isCreator: result.participant.isHost,
        subtitleServiceStarted: result.subtitleServiceStarted,
        participantSessionToken: result.participantSessionToken
      });

      emitToOtherParticipants(io, roomId, participantId, "peer:joined", {
        participantId,
        displayName: result.participant.displayName,
        isHost: result.participant.isHost,
        joinedAt: result.participant.joinedAt,
        lastSeenAt: result.participant.lastSeenAt,
        spokenLanguage: result.participant.spokenLanguage
      });
      emitRoomStatus(io, roomId);
    });

    socket.on("subtitle:start-service", (_payload, callback) => {
      const match = getSocketParticipant(socket.id);

      if (!consumeSubtitleControl("control")) {
        acknowledge(callback, { ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (!isTranscriptionConfigured()) {
        acknowledge(callback, { ok: false, reason: "NOT_CONFIGURED" });
        return;
      }

      if (
        !match ||
        !startSubtitleService(match.room.roomId, match.participant.participantId)
      ) {
        acknowledge(callback, { ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(match.room.roomId).emit("subtitle:service-started", {
        roomId: match.room.roomId,
        startedBy: match.participant.participantId
      });
      acknowledge(callback, { ok: true });
    });

    socket.on("subtitle:stop-service", (_payload, callback) => {
      const match = getSocketParticipant(socket.id);

      if (!consumeSubtitleControl("control")) {
        acknowledge(callback, { ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (
        !match ||
        !stopSubtitleService(match.room.roomId, match.participant.participantId)
      ) {
        acknowledge(callback, { ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(match.room.roomId).emit("subtitle:service-stopped", {
        roomId: match.room.roomId,
        stoppedBy: match.participant.participantId
      });
      acknowledge(callback, { ok: true });
    });

    socket.on("participant:language", (payload) => {
      const match = getSocketParticipant(socket.id);
      const spokenLanguage = payload?.spokenLanguage;

      if (!match || !isSupportedLanguage(spokenLanguage)) {
        return;
      }

      updateParticipantLanguage(
        match.room.roomId,
        match.participant.participantId,
        spokenLanguage
      );
    });

    socket.on("webrtc:offer", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "webrtc:offer", {
        toParticipantId: payload?.toParticipantId,
        description: payload?.description,
        iceRestart: payload?.iceRestart === true
      });
    });

    socket.on("webrtc:answer", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "webrtc:answer", {
        toParticipantId: payload?.toParticipantId,
        description: payload?.description
      });
    });

    socket.on("webrtc:ice-candidate", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "webrtc:ice-candidate", {
        toParticipantId: payload?.toParticipantId,
        candidate: payload?.candidate
      });
    });

    socket.on("media:screen-started", (payload) => {
      const match = getSocketParticipant(socket.id);

      if (!match) {
        return;
      }

      const result = startScreenShare(
        match.room.roomId,
        match.participant.participantId,
        payload?.streamId
      );

      if (!result.ok) {
        socket.emit("media:screen-rejected", {
          reason: result.reason,
          activeParticipantId:
            "activeParticipantId" in result ? result.activeParticipantId : undefined
        });
        return;
      }

      emitToOtherParticipants(
        io,
        match.room.roomId,
        match.participant.participantId,
        "media:screen-started",
        {
          from: match.participant.participantId,
          roomId: match.room.roomId,
          streamId: result.streamId
        }
      );
      socket.emit("media:screen-accepted", {
        roomId: match.room.roomId,
        streamId: result.streamId
      });
    });

    socket.on("media:screen-stopped", () => {
      const match = getSocketParticipant(socket.id);

      if (!match) {
        return;
      }

      stopScreenShare(match.room.roomId, match.participant.participantId);
      emitToOtherParticipants(
        io,
        match.room.roomId,
        match.participant.participantId,
        "media:screen-stopped",
        {
          from: match.participant.participantId,
          roomId: match.room.roomId
        }
      );
    });

    socket.on("media:camera-started", () => {
      const match = getSocketParticipant(socket.id);

      if (!match) {
        return;
      }

      emitToOtherParticipants(
        io,
        match.room.roomId,
        match.participant.participantId,
        "media:camera-started",
        {
          from: match.participant.participantId,
          roomId: match.room.roomId
        }
      );
    });

    socket.on("media:camera-stopped", () => {
      const match = getSocketParticipant(socket.id);

      if (!match) {
        return;
      }

      emitToOtherParticipants(
        io,
        match.room.roomId,
        match.participant.participantId,
        "media:camera-stopped",
        {
          from: match.participant.participantId,
          roomId: match.room.roomId
        }
      );
    });

    socket.on("chat:send", async (input: unknown, callback: unknown) => {
      const match = getSocketParticipant(socket.id);
      if (!match) return acknowledge(callback, { ok: false });
      if (!input || typeof input !== "object") return acknowledge(callback, { ok: false });
      const { text, clientMessageId, attachment } = input as Record<string, unknown>;
      if (typeof text !== "string" || (!text.trim() && !attachment) || text.length > chatTextLimit ||
          typeof clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientMessageId)) {
        return acknowledge(callback, { ok: false });
      }
      let file: ChatMessage["attachment"];
      if (attachment !== undefined) {
        if (!attachment || typeof attachment !== "object") return acknowledge(callback, { ok: false });
        const { id, name, size } = attachment as Record<string, unknown>;
        if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
            typeof name !== "string" || !name.trim() || name.length > 255 ||
            typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > fileSizeLimit) {
          return acknowledge(callback, { ok: false });
        }
        file = { id, name: name.replace(/[\/\\\x00-\x1f]/g, "_").trim(), size };
      }
      const { room, participant } = match;
      const key = `${participant.participantId}:${clientMessageId}`;
      const recent = recentChats.get(room) ?? new Map<string, ChatMessage>();
      recentChats.set(room, recent);
      const existing = recent.get(key);
      if (existing) return acknowledge(callback, { ok: existing.originalText === text.trim() && existing.attachment?.id === file?.id, message: existing });
      if (!consumeChat("chat") || (room.subtitleServiceStarted && activeChatTranslations >= 4)) {
        return acknowledge(callback, { ok: false });
      }
      const message: ChatMessage = {
        attachment: file, id: randomUUID(), roomId: room.roomId, speakerId: participant.participantId,
        speakerName: participant.displayName, originalLanguage: participant.spokenLanguage,
        originalText: text.trim(), translatedLanguage: participant.spokenLanguage,
        translatedText: "", translationStatus: "original", timestamp: Date.now()
      };
      recent.set(key, message);
      if (recent.size > chatLogLimit) recent.delete(recent.keys().next().value!);
      const recipients = [...room.participants.values()].filter(p => p.socketId).map(p => ({ ...p }));
      for (const recipient of recipients) {
        io.to(recipient.socketId!).emit("chat:message", {
          ...message, translatedLanguage: recipient.spokenLanguage,
          translationStatus: !!message.originalText && room.subtitleServiceStarted && recipient.spokenLanguage !== message.originalLanguage
            ? "pending" : "original"
        });
      }
      acknowledge(callback, { ok: true, message });
      if (!room.subtitleServiceStarted || !message.originalText) return;
      const signal = AbortSignal.any([room.captionAbortController.signal, connectionAbort.signal, AbortSignal.timeout(12_000)]);
      const languages = [...new Set(recipients.map(p => p.spokenLanguage))].filter(language => language !== message.originalLanguage);
      activeChatTranslations++;
      try {
        await Promise.all(languages.map(async language => {
          let translatedText = "";
          try {
            translatedText = await providers.translateText({ text: message.originalText,
              sourceLanguage: message.originalLanguage, targetLanguage: language, signal });
            signal.throwIfAborted();
          } catch { translatedText = ""; }
          if (getRoom(room.roomId) !== room) return;
          for (const recipient of recipients) {
            const current = room.participants.get(recipient.participantId);
            if (recipient.spokenLanguage === language && current?.socketId === recipient.socketId) {
              io.to(recipient.socketId!).emit("chat:message", { ...message, translatedLanguage: language,
                translatedText, translationStatus: translatedText.trim() ? "translated" : "unavailable" });
            }
          }
        }));
      } finally { activeChatTranslations--; }
    });

    socket.on("audio:segment", async (input: unknown) => {
      if (!consumeAudio("audio")) {
        return;
      }

      const match = getSocketParticipant(socket.id);
      const room = match?.room;
      const participant = match?.participant;

      if (!room || !participant) {
        return;
      }

      if (!room.subtitleServiceStarted) {
        return;
      }

      const payload = parseAudioSegment(input);
      if (!payload) return;
      const { audio } = payload;

      if (!payload.clientSegmentId || seenSegments.has(payload.clientSegmentId)) return;
      if (activeSegments >= 2) {
        socket.emit("caption:error", { message: "caption-busy" });
        return;
      }
      seenSegments.add(payload.clientSegmentId);
      if (seenSegments.size > 64) seenSegments.delete(seenSegments.values().next().value!);
      const sequence = ++segmentSequence;
      const speaker = { ...participant };
      const recipients = [...room.participants.values()].filter(p => p.socketId && p.participantId !== speaker.participantId)
        .map(p => ({ ...p }));
      const timestamp = Date.now();
      const serviceSignal = room.captionAbortController.signal;
      const connectionSignal = connectionAbort.signal;
      const signal = AbortSignal.any([serviceSignal, connectionSignal, AbortSignal.timeout(20_000)]);
      activeSegments += 1;
      try {
        let originalText = "";
        const canPublish = () => {
          const current = getSocketParticipant(socket.id);
          return !signal.aborted && current?.room === room &&
            current.participant.spokenLanguage === speaker.spokenLanguage;
        };
        const caption = (language: Language, text: string) => buildCaption({
          roomId: room.roomId, speaker, originalText,
          translatedLanguage: language, translatedText: text, isFinal: payload.isFinal, timestamp
        });
        const result = await processCaptionSegment({
          audio, language: speaker.spokenLanguage, isFinal: payload.isFinal,
          targetLanguages: recipients.map(p => p.spokenLanguage), signal,
          onTranscript(text) {
            originalText = text;
            if (canPublish() && sequence > lastPreviewSequence) {
              lastPreviewSequence = sequence;
              socket.emit("caption:preview", caption(speaker.spokenLanguage, text));
            }
          },
          onTranslation(language, text) {
            if (!canPublish() || sequence <= (lastTranslationSequence.get(language) ?? 0)) return;
            lastTranslationSequence.set(language, sequence);
            for (const recipient of recipients) {
              const currentRecipient = room.participants.get(recipient.participantId);
              if (recipient.spokenLanguage === language && currentRecipient?.socketId === recipient.socketId &&
                  currentRecipient?.spokenLanguage === language) {
                io.to(recipient.socketId!).emit("caption", caption(language, text));
              }
            }
          }
        }, providers);
        if (!canPublish()) return;
        if (result.translationFailed) socket.emit("caption:error", { message: "translation-unavailable" });
      } catch {
        if (!serviceSignal.aborted && !connectionSignal.aborted) {
          socket.emit("caption:error", { message: "caption-unavailable" });
        }
      } finally {
        activeSegments -= 1;
      }
    });

    socket.on("room:leave", () => {
      connectionAbort.abort();
      const match = getSocketParticipant(socket.id);
      if (!match) {
        return;
      }

      const { room, participant } = match;
      const roomId = room.roomId;
      const participantId = participant.participantId;
      const wasScreenSharing = room.activeScreenShareParticipantId === participantId;
      const leaveResult = leaveRoom(roomId, participantId);
      socketParticipantSessions.delete(socket.id);
      clearDisconnectExpiry(roomId, participantId);

      if (leaveResult.roomEnded) {
        emitRoomEnded(io, roomId, participantId);
        clearRoomDisconnectExpiries(roomId);
        return;
      }

      if (wasScreenSharing) {
        emitToOtherParticipants(io, roomId, participantId, "media:screen-stopped", {
          from: participantId,
          roomId
        });
      }

      emitToOtherParticipants(io, roomId, participantId, "peer:left", {
        participantId
      });
      socket.leave(roomId);
      emitRoomStatus(io, roomId);
    });

    socket.on("disconnect", () => {
      connectionAbort.abort();
      const match = findParticipantBySocket(socket.id);
      if (!match) {
        socketParticipantSessions.delete(socket.id);
        return;
      }

      const roomId = match.room.roomId;
      const participantId = match.participant.participantId;
      const wasScreenSharing =
        match.room.activeScreenShareParticipantId === participantId;

      markParticipantDisconnected(roomId, participantId);
      socketParticipantSessions.delete(socket.id);

      if (wasScreenSharing) {
        emitToOtherParticipants(io, roomId, participantId, "media:screen-stopped", {
          from: participantId,
          roomId
        });
      }

      emitToOtherParticipants(io, roomId, participantId, "peer:left", {
        participantId
      });
      scheduleDisconnectExpiry(io, roomId, participantId);
      emitRoomStatus(io, roomId);
    });
  });

  return io;
}
