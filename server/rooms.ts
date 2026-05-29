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
  sessionTokenHash: string;
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
  maxParticipants: number;
  activeScreenShareParticipantId?: string;
  subtitleServiceStarted: boolean;
  participants: Map<string, Participant>;
  failedAttempts: Map<string, FailedAttempts>;
};

const rooms = new Map<string, Room>();
const roomTtlMs = 4 * 60 * 60 * 1000;
export const participantReconnectTtlMs = 2 * 60 * 1000;
const maxFailedAttempts = 5;
const blockMs = 60 * 1000;
export const maxRoomParticipants = 6;

export const creatorCookieName = (roomId: string) => `jec_creator_${roomId}`;

function generateRoomId() {
  return crypto.randomBytes(3).toString("hex");
}

function generateRoomCode() {
  return crypto.randomInt(0, 10000).toString().padStart(4, "0");
}

function generateUniqueRoomCode() {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const roomCode = generateRoomCode();
    const isInUse = [...rooms.values()].some((room) => room.roomCode === roomCode);

    if (!isInUse) {
      return roomCode;
    }
  }

  throw new Error("No room codes available");
}

function generateParticipantSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashParticipantSessionToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isParticipantSessionToken(
  participant: Participant | undefined,
  token: unknown
) {
  if (!participant || typeof token !== "string" || !token) {
    return false;
  }

  return constantTimeEqual(
    participant.sessionTokenHash,
    hashParticipantSessionToken(token)
  );
}

function cleanupRooms() {
  const now = Date.now();

  for (const [roomId, room] of rooms) {
    if (now - room.createdAt > roomTtlMs) {
      rooms.delete(roomId);
      continue;
    }

    for (const participant of room.participants.values()) {
      if (
        participant.socketId ||
        now - participant.lastSeenAt <= participantReconnectTtlMs
      ) {
        continue;
      }

      if (participant.isHost) {
        rooms.delete(roomId);
        break;
      }

      if (room.activeScreenShareParticipantId === participant.participantId) {
        room.activeScreenShareParticipantId = undefined;
      }

      room.participants.delete(participant.participantId);
    }
  }
}

export function createRoom({ spokenLanguage }: { spokenLanguage: Language }): Room {
  rooms.clear();

  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  const room: Room = {
    roomId,
    roomCode: generateUniqueRoomCode(),
    creatorSecret: crypto.randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
    maxParticipants: maxRoomParticipants,
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

export function getRoomByCode(roomCode: string): Room | undefined {
  cleanupRooms();

  for (const room of rooms.values()) {
    if (room.roomCode === roomCode) {
      return room;
    }
  }

  return undefined;
}

export function roomExists(roomId: string) {
  return Boolean(getRoom(roomId));
}

export function isCreatorSecret(roomId: string, secret: string | undefined) {
  const room = getRoom(roomId);
  return Boolean(room && secret && room.creatorSecret === secret);
}

export function isRoomParticipantSession(
  roomId: string,
  participantId: string,
  participantSessionToken: unknown
) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  return isParticipantSessionToken(participant, participantSessionToken);
}

export type JoinFailureReason =
  | "ROOM_NOT_FOUND"
  | "INVALID_CODE"
  | "TOO_MANY_ATTEMPTS"
  | "ROOM_FULL"
  | "INVALID_SESSION"
  | "INVALID_LANGUAGE";

export type JoinResult =
  | {
      ok: true;
      participant: Participant;
      otherParticipants: Participant[];
      participantCount: number;
      subtitleServiceStarted: boolean;
      participantSessionToken: string;
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
  participantSessionToken,
  socketId,
  isCreator
}: {
  roomId: string;
  participantId: string;
  spokenLanguage: unknown;
  displayName?: unknown;
  roomCode?: string;
  participantSessionToken?: unknown;
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
  const isSameSocketParticipant = existingParticipant?.socketId === socketId;
  const hasValidParticipantSession = isParticipantSessionToken(
    existingParticipant,
    participantSessionToken
  );
  const normalizedDisplayName =
    typeof displayName === "string" ? normalizeDisplayName(displayName) : "";
  const attempt = room.failedAttempts.get(participantId);

  if (alreadyJoined && !hasValidParticipantSession && !isSameSocketParticipant) {
    return { ok: false, reason: "INVALID_SESSION" };
  }

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

  if (!alreadyJoined && room.participants.size >= room.maxParticipants) {
    return { ok: false, reason: "ROOM_FULL" };
  }

  room.failedAttempts.delete(participantId);

  const nextParticipantSessionToken =
    existingParticipant &&
    hasValidParticipantSession &&
    typeof participantSessionToken === "string"
      ? participantSessionToken
      : generateParticipantSessionToken();
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
    lastSeenAt: now,
    sessionTokenHash:
      existingParticipant && hasValidParticipantSession
        ? existingParticipant.sessionTokenHash
        : hashParticipantSessionToken(nextParticipantSessionToken)
  };

  room.participants.set(participantId, participant);

  const otherParticipants = [...room.participants.values()].filter(
    (item) => item.participantId !== participantId && item.socketId
  );

  return {
    ok: true,
    participant,
    otherParticipants,
    participantCount: room.participants.size,
    subtitleServiceStarted: room.subtitleServiceStarted,
    participantSessionToken: nextParticipantSessionToken
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

export function stopSubtitleService(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!room || !participant?.isHost) {
    return false;
  }

  room.subtitleServiceStarted = false;
  return true;
}

export function startScreenShare(
  roomId: string,
  participantId: string,
  streamId: unknown
) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);
  const normalizedStreamId = typeof streamId === "string" ? streamId : "";

  if (!room || !participant || !normalizedStreamId) {
    return { ok: false, reason: "INVALID_SESSION" as const };
  }

  if (
    room.activeScreenShareParticipantId &&
    room.activeScreenShareParticipantId !== participantId
  ) {
    return {
      ok: false,
      reason: "SCREEN_SHARE_ACTIVE" as const,
      activeParticipantId: room.activeScreenShareParticipantId
    };
  }

  room.activeScreenShareParticipantId = participantId;
  return { ok: true as const, participant, streamId: normalizedStreamId };
}

export function stopScreenShare(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!room || !participant) {
    return { ok: false, reason: "INVALID_SESSION" as const };
  }

  if (room.activeScreenShareParticipantId === participantId) {
    room.activeScreenShareParticipantId = undefined;
  }

  return { ok: true as const, participant };
}

export function leaveRoom(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  if (!room) {
    return { roomEnded: false, participant: undefined };
  }

  const participant = room.participants.get(participantId);

  if (participant?.isHost) {
    rooms.delete(roomId);
    return { roomEnded: true, participant };
  }

  if (room.activeScreenShareParticipantId === participantId) {
    room.activeScreenShareParticipantId = undefined;
  }

  room.participants.delete(participantId);
  return { roomEnded: false, participant };
}

export function markParticipantDisconnected(roomId: string, participantId: string) {
  const room = getRoom(roomId);
  const participant = room?.participants.get(participantId);

  if (!room || !participant) {
    return { roomEnded: false, participant: undefined };
  }

  participant.socketId = undefined;
  participant.lastSeenAt = Date.now();

  if (room.activeScreenShareParticipantId === participantId) {
    room.activeScreenShareParticipantId = undefined;
  }

  return { roomEnded: false, participant };
}

export function expireDisconnectedParticipant(
  roomId: string,
  participantId: string
) {
  const room = rooms.get(roomId);
  const participant = room?.participants.get(participantId);

  if (!room || !participant || participant.socketId) {
    return { expired: false, roomEnded: false, participant };
  }

  if (Date.now() - participant.lastSeenAt < participantReconnectTtlMs) {
    return { expired: false, roomEnded: false, participant };
  }

  if (participant.isHost) {
    rooms.delete(roomId);
    return { expired: true, roomEnded: true, participant };
  }

  if (room.activeScreenShareParticipantId === participantId) {
    room.activeScreenShareParticipantId = undefined;
  }

  room.participants.delete(participantId);
  return { expired: true, roomEnded: false, participant };
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

export function resetRoomsForTests() {
  rooms.clear();
}
