import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { isSupportedLanguage, oppositeLanguage } from "../lib/i18n";
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
  startSubtitleService,
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
        const originalLanguage = participant.spokenLanguage;
        const translatedLanguage = oppositeLanguage(originalLanguage);
        const originalText = await transcribeSpeech({
          audio,
          language: originalLanguage,
          isFinal: payload.isFinal
        });

        if (!originalText) {
          return;
        }

        const translatedText = await translateText({
          text: originalText,
          sourceLanguage: originalLanguage,
          targetLanguage: translatedLanguage
        });

        if (!translatedText) {
          return;
        }

        const caption: CaptionEvent = {
          roomId: payload.roomId,
          speakerId: payload.participantId,
          originalLanguage,
          originalText,
          translatedLanguage,
          translatedText,
          isFinal: payload.isFinal,
          timestamp: Date.now()
        };

        emitToOtherParticipant(
          io,
          payload.roomId,
          payload.participantId,
          "caption",
          caption
        );

        socket.emit("caption:preview", caption);
      } catch (error) {
        socket.emit("caption:error", {
          message: error instanceof Error ? error.message : "subtitle-error"
        });
      }
    });

    socket.on("room:leave", (payload) => {
      const roomId = String(payload?.roomId ?? "");
      const participantId = String(payload?.participantId ?? "");
      leaveRoom(roomId, participantId);
      socket.leave(roomId);
      emitToOtherParticipant(io, roomId, participantId, "peer:left", {
        participantId
      });
      emitRoomStatus(io, roomId);
    });

    socket.on("disconnect", () => {
      const match = findParticipantBySocket(socket.id);
      if (!match) {
        return;
      }

      leaveRoom(match.room.roomId, match.participant.participantId);
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
