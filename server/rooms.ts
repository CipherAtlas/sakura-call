import crypto from "node:crypto";
import type { Language } from "../lib/i18n";
import { isSupportedLanguage, normalizeDisplayName } from "../lib/i18n";

export type Participant = {
  participantId: string;
  displayName: string;
  spokenLanguage: Language;
  socketId?: string;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt: number;
};

type FailedAttempts = {
  count: number;
  blockedUntil: number;
};

export type Room = {
  roomId: string;
  roomCode: string;
  creatorSecret: string;
  createdAt: number;
  subtitleServiceStarted: boolean;
  participants: Map<string, Participant>;
  failedAttempts: Map<string, FailedAttempts>;
};

const rooms = new Map<string, Room>();
const roomTtlMs = 4 * 60 * 60 * 1000;
const maxFailedAttempts = 5;
const blockMs = 60 * 1000;

export const creatorCookieName = (roomId: string) => `jec_creator_${roomId}`;

function generateRoomId() {
  return crypto.randomBytes(3).toString("hex");
}

function generateRoomCode() {
  return crypto.randomInt(0, 10000).toString().padStart(4, "0");
}

function cleanupRooms() {
  const now = Date.now();

  for (const [roomId, room] of rooms) {
    if (now - room.createdAt > roomTtlMs) {
      rooms.delete(roomId);
    }
  }
}

export function createRoom(spokenLanguage: Language): Room {
  cleanupRooms();

  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  const room: Room = {
    roomId,
    roomCode: generateRoomCode(),
    creatorSecret: crypto.randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
    subtitleServiceStarted: false,
    participants: new Map(),
    failedAttempts: new Map()
  };

  rooms.set(roomId, room);
  void spokenLanguage;

  return room;
}

export function getRoom(roomId: string): Room | undefined {
  cleanupRooms();
  return rooms.get(roomId);
}

export function roomExists(roomId: string) {
  return Boolean(getRoom(roomId));
}

export function isCreatorSecret(roomId: string, secret: string | undefined) {
  const room = getRoom(roomId);
  return Boolean(room && secret && room.creatorSecret === secret);
}

export type JoinFailureReason =
  | "ROOM_NOT_FOUND"
  | "INVALID_CODE"
  | "TOO_MANY_ATTEMPTS"
  | "ROOM_FULL"
  | "INVALID_LANGUAGE";

export type JoinResult =
  | {
      ok: true;
      participant: Participant;
      otherParticipants: Participant[];
      participantCount: number;
      subtitleServiceStarted: boolean;
    }
  | {
      ok: false;
      reason: JoinFailureReason;
      blockedUntil?: number;
    };

export function joinRoom({
  roomId,
  participantId,
  spokenLanguage,
  displayName,
  roomCode,
  socketId,
  isCreator
}: {
  roomId: string;
  participantId: string;
  spokenLanguage: unknown;
  displayName?: unknown;
  roomCode?: string;
  socketId: string;
  isCreator: boolean;
}): JoinResult {
  const room = getRoom(roomId);
  const now = Date.now();

  if (!room) {
    return { ok: false, reason: "ROOM_NOT_FOUND" };
  }

  if (!isSupportedLanguage(spokenLanguage)) {
    return { ok: false, reason: "INVALID_LANGUAGE" };
  }

  const alreadyJoined = room.participants.has(participantId);
  const existingParticipant = room.participants.get(participantId);
  const normalizedDisplayName =
    typeof displayName === "string" ? normalizeDisplayName(displayName) : "";
  const attempt = room.failedAttempts.get(participantId);

  if (!isCreator && !alreadyJoined) {
    if (attempt && attempt.blockedUntil > now) {
      return {
        ok: false,
        reason: "TOO_MANY_ATTEMPTS",
        blockedUntil: attempt.blockedUntil
      };
    }

    if (!/^\d{4}$/.test(roomCode ?? "") || roomCode !== room.roomCode) {
      const nextCount = (attempt?.count ?? 0) + 1;
      room.failedAttempts.set(participantId, {
        count: nextCount,
        blockedUntil: nextCount >= maxFailedAttempts ? now + blockMs : 0
      });

      return { ok: false, reason: "INVALID_CODE" };
    }
  }

  if (!alreadyJoined && room.participants.size >= 2) {
    return { ok: false, reason: "ROOM_FULL" };
  }

  room.failedAttempts.delete(participantId);

  const participant: Participant = {
    participantId,
    displayName:
      normalizedDisplayName || existingParticipant?.displayName || "Guest",
    spokenLanguage,
    socketId,
    isHost: existingParticipant?.isHost ?? isCreator,
    joinedAt: alreadyJoined
      ? existingParticipant?.joinedAt ?? now
      : now,
    lastSeenAt: now
  };

  room.participants.set(participantId, participant);

  const otherParticipants = [...room.participants.values()].filter(
    (item) => item.participantId !== participantId
  );

  return {
    ok: true,
    participant,
    otherParticipants,
    participantCount: room.participants.size,
    subtitleServiceStarted: room.subtitleServiceStarted
  };
}

export function startSubtitleService(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!room || !participant?.isHost) {
    return false;
  }

  room.subtitleServiceStarted = true;
  return true;
}

export function leaveRoom(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  room.participants.delete(participantId);
}

export function updateParticipantLanguage(
  roomId: string,
  participantId: string,
  spokenLanguage: Language
) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!participant) {
    return false;
  }

  participant.spokenLanguage = spokenLanguage;
  participant.lastSeenAt = Date.now();
  return true;
}

export function findParticipantBySocket(socketId: string) {
  for (const room of rooms.values()) {
    for (const participant of room.participants.values()) {
      if (participant.socketId === socketId) {
        return { room, participant };
      }
    }
  }

  return null;
}
