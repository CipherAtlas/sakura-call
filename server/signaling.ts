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
import {
  creatorCookieName,
  findParticipantBySocket,
  getRoom,
  isCreatorSecret,
  joinRoom,
  leaveRoom,
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
  roomId: string;
  participantId: string;
  spokenLanguage: "en" | "ja";
  audio: ArrayBuffer | Buffer;
  isFinal: boolean;
  clientSegmentId: string;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const rateLimits = new Map<string, RateLimitState>();

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
      origin: true,
      credentials: true
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
        socketId: socket.id,
        isCreator
      });

      if (!result.ok) {
        callback?.(result);
        return;
      }

      socket.join(roomId);
      callback?.({
        ok: true,
        participant: result.participant,
        otherParticipants: result.otherParticipants,
        participantCount: result.participantCount,
        isCreator: result.participant.isHost,
        subtitleServiceStarted: result.subtitleServiceStarted
      });

      emitToOtherParticipant(io, roomId, participantId, "peer:joined", {
        participantId,
        displayName: result.participant.displayName,
        spokenLanguage: result.participant.spokenLanguage
      });
      emitRoomStatus(io, roomId);
    });

    socket.on("subtitle:start-service", (payload, callback) => {
      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");

      if (!consumeRateLimit(`subtitle:start:${socket.id}`, 8, 60_000)) {
        callback?.({ ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (!isTranscriptionConfigured()) {
        callback?.({ ok: false, reason: "NOT_CONFIGURED" });
        return;
      }

      if (!startSubtitleService(roomId, participantId)) {
        callback?.({ ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(roomId).emit("subtitle:service-started", {
        roomId,
        startedBy: participantId
      });
      callback?.({ ok: true });
    });

    socket.on("subtitle:stop-service", (payload, callback) => {
      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");

      if (!consumeRateLimit(`subtitle:stop:${socket.id}`, 8, 60_000)) {
        callback?.({ ok: false, reason: "RATE_LIMITED" });
        return;
      }

      if (!stopSubtitleService(roomId, participantId)) {
        callback?.({ ok: false, reason: "HOST_ONLY" });
        return;
      }

      io.to(roomId).emit("subtitle:service-stopped", {
        roomId,
        stoppedBy: participantId
      });
      callback?.({ ok: true });
    });

    socket.on("participant:language", (payload) => {
      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");
      const spokenLanguage = payload?.spokenLanguage;

      if (!isSupportedLanguage(spokenLanguage)) {
        return;
      }

      updateParticipantLanguage(roomId, participantId, spokenLanguage);
    });

    socket.on("webrtc:offer", (payload) => {
      emitToOtherParticipant(io, String(payload?.roomId ?? ""), String(payload?.from ?? ""), "webrtc:offer", payload);
    });

    socket.on("webrtc:answer", (payload) => {
      emitToOtherParticipant(io, String(payload?.roomId ?? ""), String(payload?.from ?? ""), "webrtc:answer", payload);
    });

    socket.on("webrtc:ice-candidate", (payload) => {
      emitToOtherParticipant(
        io,
        String(payload?.roomId ?? ""),
        String(payload?.from ?? ""),
        "webrtc:ice-candidate",
        payload
      );
    });

    socket.on("audio:segment", async (payload: AudioSegmentPayload) => {
      if (!consumeRateLimit(`audio:${socket.id}`, 40, 60_000)) {
        return;
      }

      const room = getRoom(payload.roomId);
      const participant = room?.participants.get(payload.participantId);

      if (!room || !participant || participant.socketId !== socket.id) {
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
            roomId: payload.roomId,
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

    socket.on("room:leave", (payload) => {
      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");
      const leaveResult = leaveRoom(roomId, participantId);

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
        return;
      }

      const leaveResult = leaveRoom(match.room.roomId, match.participant.participantId);

      if (leaveResult.roomEnded) {
        emitRoomEnded(io, match.room.roomId, match.participant.participantId);
        return;
      }

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
