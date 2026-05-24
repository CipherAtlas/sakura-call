import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { isSupportedLanguage } from "../lib/i18n";
import type { Language } from "../lib/i18n";
import {
  isTranscriptionConfigured,
  transcribeSpeech
} from "../lib/transcription";
import { translateText } from "../lib/translation";
import { parseCookies } from "./cookies";
import { isAllowedOrigin } from "./origin";
import {
  creatorCookieName,
  findParticipantBySocket,
  getRoom,
  isCreatorSecret,
  joinRoom,
  leaveRoom,
  markParticipantDisconnected,
  Participant,
  startSubtitleService,
  stopSubtitleService,
  updateParticipantLanguage
} from "./rooms";

type CaptionEvent = {
  roomId: string;
  speakerId: string;
  originalLanguage: "en" | "ja";
  originalText: string;
  translatedLanguage: "en" | "ja";
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
};

type AudioSegmentPayload = {
  audio: ArrayBuffer | Buffer;
  isFinal: boolean;
  clientSegmentId: string;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const rateLimits = new Map<string, RateLimitState>();

type SocketParticipantSession = {
  roomId: string;
  participantId: string;
};

const socketParticipantSessions = new Map<string, SocketParticipantSession>();

function consumeRateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const state = rateLimits.get(key);

  if (!state || state.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (state.count >= max) {
    return false;
  }

  state.count += 1;
  return true;
}

function normalizeAudioBuffer(audio: ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(audio)) {
    return audio;
  }

  return Buffer.from(audio);
}

function emitRoomStatus(io: Server, roomId: string) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  io.to(roomId).emit("room:status", {
    participantCount: room.participants.size
  });
}

function emitToOtherParticipant(
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

function emitRoomEnded(io: Server, roomId: string, endedBy: string) {
  io.to(roomId).emit("room:ended", {
    roomId,
    endedBy
  });
  void io.in(roomId).socketsLeave(roomId);
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

function emitAuthorizedPeerEvent(
  io: Server,
  socketId: string,
  event: string,
  payload: Record<string, unknown>
) {
  const match = getSocketParticipant(socketId);
  if (!match) {
    return;
  }

  emitToOtherParticipant(
    io,
    match.room.roomId,
    match.participant.participantId,
    event,
    {
      ...payload,
      roomId: match.room.roomId,
      from: match.participant.participantId
    }
  );
}

async function captionTextForLanguage({
  originalText,
  originalLanguage,
  targetLanguage
}: {
  originalText: string;
  originalLanguage: Language;
  targetLanguage: Language;
}) {
  if (originalLanguage === targetLanguage) {
    return originalText;
  }

  return translateText({
    text: originalText,
    sourceLanguage: originalLanguage,
    targetLanguage
  });
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

export function createSignalingServer(httpServer: HttpServer) {
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

  io.on("connection", (socket) => {
    socket.on("room:join", (payload, callback) => {
      if (!consumeRateLimit(`join:${socket.id}`, 20, 60_000)) {
        callback?.({ ok: false, reason: "TOO_MANY_ATTEMPTS" });
        return;
      }

      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");
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
        roomCode: payload?.roomCode,
        participantSessionToken: payload?.participantSessionToken,
        socketId: socket.id,
        isCreator
      });

      if (!result.ok) {
        callback?.(result);
        return;
      }

      socket.join(roomId);
      socketParticipantSessions.set(socket.id, {
        roomId,
        participantId
      });
      callback?.({
        ok: true,
        participant: publicParticipant(result.participant),
        otherParticipants: result.otherParticipants.map(publicParticipant),
        participantCount: result.participantCount,
        isCreator: result.participant.isHost,
        subtitleServiceStarted: result.subtitleServiceStarted,
        participantSessionToken: result.participantSessionToken
      });

      emitToOtherParticipant(io, roomId, participantId, "peer:joined", {
        participantId,
        displayName: result.participant.displayName,
        spokenLanguage: result.participant.spokenLanguage
      });
      emitRoomStatus(io, roomId);
    });

    socket.on("subtitle:start-service", (_payload, callback) => {
      const match = getSocketParticipant(socket.id);

      if (!consumeRateLimit(`subtitle:start:${socket.id}`, 8, 60_000)) {
        callback?.({ ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (!isTranscriptionConfigured()) {
        callback?.({ ok: false, reason: "NOT_CONFIGURED" });
        return;
      }

      if (
        !match ||
        !startSubtitleService(match.room.roomId, match.participant.participantId)
      ) {
        callback?.({ ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(match.room.roomId).emit("subtitle:service-started", {
        roomId: match.room.roomId,
        startedBy: match.participant.participantId
      });
      callback?.({ ok: true });
    });

    socket.on("subtitle:stop-service", (_payload, callback) => {
      const match = getSocketParticipant(socket.id);

      if (!consumeRateLimit(`subtitle:stop:${socket.id}`, 8, 60_000)) {
        callback?.({ ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (
        !match ||
        !stopSubtitleService(match.room.roomId, match.participant.participantId)
      ) {
        callback?.({ ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(match.room.roomId).emit("subtitle:service-stopped", {
        roomId: match.room.roomId,
        stoppedBy: match.participant.participantId
      });
      callback?.({ ok: true });
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
        description: payload?.description
      });
    });

    socket.on("webrtc:answer", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "webrtc:answer", {
        description: payload?.description
      });
    });

    socket.on("webrtc:ice-candidate", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "webrtc:ice-candidate", {
        candidate: payload?.candidate
      });
    });

    socket.on("media:screen-started", (payload) => {
      emitAuthorizedPeerEvent(io, socket.id, "media:screen-started", {
        streamId: payload?.streamId
      });
    });

    socket.on("media:screen-stopped", () => {
      emitAuthorizedPeerEvent(io, socket.id, "media:screen-stopped", {});
    });

    socket.on("media:camera-started", () => {
      emitAuthorizedPeerEvent(io, socket.id, "media:camera-started", {});
    });

    socket.on("media:camera-stopped", () => {
      emitAuthorizedPeerEvent(io, socket.id, "media:camera-stopped", {});
    });

    socket.on("audio:segment", async (payload: AudioSegmentPayload) => {
      if (!consumeRateLimit(`audio:${socket.id}`, 40, 60_000)) {
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

      const audio = normalizeAudioBuffer(payload.audio);
      if (audio.byteLength < 1000 || audio.byteLength > 900_000) {
        return;
      }

      try {
        const originalText = await transcribeSpeech({
          audio,
          language: participant.spokenLanguage,
          isFinal: payload.isFinal
        });

        if (!originalText) {
          return;
        }

        const timestamp = Date.now();

        for (const recipient of room.participants.values()) {
          if (recipient.participantId === participant.participantId) {
            continue;
          }

          if (!recipient.socketId) {
            continue;
          }

          const translatedText = await captionTextForLanguage({
            originalText,
            originalLanguage: participant.spokenLanguage,
            targetLanguage: recipient.spokenLanguage
          });

          if (!translatedText) {
            continue;
          }

          const caption = buildCaption({
            roomId: room.roomId,
            speaker: participant,
            originalText,
            translatedLanguage: recipient.spokenLanguage,
            translatedText,
            isFinal: payload.isFinal,
            timestamp
          });

          io.to(recipient.socketId).emit("caption", caption);
          socket.emit("caption:preview", caption);
        }
      } catch (error) {
        socket.emit("caption:error", {
          message: error instanceof Error ? error.message : "subtitle-error"
        });
      }
    });

    socket.on("room:leave", () => {
      const match = getSocketParticipant(socket.id);
      if (!match) {
        return;
      }

      const { room, participant } = match;
      const roomId = room.roomId;
      const participantId = participant.participantId;
      const leaveResult = leaveRoom(roomId, participantId);
      socketParticipantSessions.delete(socket.id);

      if (leaveResult.roomEnded) {
        emitRoomEnded(io, roomId, participantId);
        return;
      }

      emitToOtherParticipant(io, roomId, participantId, "peer:left", {
        participantId
      });
      socket.leave(roomId);
      emitRoomStatus(io, roomId);
    });

    socket.on("disconnect", () => {
      const match = findParticipantBySocket(socket.id);
      if (!match) {
        socketParticipantSessions.delete(socket.id);
        return;
      }

      markParticipantDisconnected(
        match.room.roomId,
        match.participant.participantId
      );
      socketParticipantSessions.delete(socket.id);

      emitToOtherParticipant(
        io,
        match.room.roomId,
        match.participant.participantId,
        "peer:left",
        {
          participantId: match.participant.participantId
        }
      );
      emitRoomStatus(io, match.room.roomId);
    });
  });

  return io;
}
