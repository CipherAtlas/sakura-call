import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveRoomExistsError,
  createRoom,
  joinRoom,
  leaveRoom,
  markParticipantDisconnected,
  maxRoomParticipants,
  resetRoomsForTests,
  startScreenShare,
  stopScreenShare,
} from "./rooms";
import { isAuthorizedPeerTarget } from "./signaling";

function join({
  displayName,
  isCreator = false,
  participantId,
  roomCode,
  roomId,
  sessionToken,
  socketId = participantId,
}: {
  displayName: string;
  isCreator?: boolean;
  participantId: string;
  roomCode?: string;
  roomId: string;
  sessionToken?: string;
  socketId?: string;
}) {
  return joinRoom({
    displayName,
    isCreator,
    participantId,
    participantSessionToken: sessionToken,
    roomCode,
    roomId,
    socketId,
    spokenLanguage: "en",
  });
}

test("creates rooms with a fixed six-person capacity", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });

  assert.equal(room.maxParticipants, maxRoomParticipants);
});

test("blocks new rooms until the host leaves the active room", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const host = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });
  const guest = join({
    displayName: "Guest",
    participantId: "guest",
    roomCode: room.roomCode,
    roomId: room.roomId,
  });

  assert.equal(host.ok, true);
  assert.equal(guest.ok, true);

  assert.throws(
    () => createRoom({ spokenLanguage: "en" }),
    (error) => {
      assert.equal(error instanceof ActiveRoomExistsError, true);
      assert.equal((error as ActiveRoomExistsError).room.roomId, room.roomId);
      return true;
    },
  );

  assert.equal(
    join({
      displayName: "Late Guest",
      participantId: "late-guest",
      roomCode: room.roomCode,
      roomId: room.roomId,
    }).ok,
    true,
  );

  assert.deepEqual(leaveRoom(room.roomId, "guest"), {
    roomEnded: false,
    participant: guest.ok ? guest.participant : undefined,
  });
  assert.throws(
    () => createRoom({ spokenLanguage: "en" }),
    ActiveRoomExistsError,
  );

  assert.deepEqual(leaveRoom(room.roomId, "host"), {
    roomEnded: true,
    participant: host.ok ? host.participant : undefined,
  });

  const nextRoom = createRoom({ spokenLanguage: "en" });
  assert.equal(nextRoom.maxParticipants, maxRoomParticipants);
});

test("enforces fixed room capacity", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const host = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });

  assert.equal(host.ok, true);

  for (let index = 1; index < maxRoomParticipants; index += 1) {
    assert.equal(
      join({
        displayName: `Guest ${index}`,
        participantId: `guest-${index}`,
        roomCode: room.roomCode,
        roomId: room.roomId,
      }).ok,
      true,
    );
  }

  assert.deepEqual(
    join({
      displayName: "Guest 6",
      participantId: "guest-6",
      roomCode: room.roomCode,
      roomId: room.roomId,
    }),
    { ok: false, reason: "ROOM_FULL" },
  );
});

test("allows reconnect with the issued participant session token", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const host = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });

  assert.equal(host.ok, true);

  if (!host.ok) {
    throw new Error("host join failed");
  }

  const rejoin = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
    sessionToken: host.participantSessionToken,
    socketId: "host-reconnect",
  });

  assert.equal(rejoin.ok, true);
});

test("keeps disconnected participants reserved but out of active peer lists", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const host = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });
  const guest = join({
    displayName: "Guest",
    participantId: "guest",
    roomCode: room.roomCode,
    roomId: room.roomId,
  });

  assert.equal(host.ok, true);
  assert.equal(guest.ok, true);

  if (!guest.ok) {
    throw new Error("guest join failed");
  }

  markParticipantDisconnected(room.roomId, "guest");

  const lateGuest = join({
    displayName: "Late Guest",
    participantId: "late-guest",
    roomCode: room.roomCode,
    roomId: room.roomId,
  });

  assert.equal(lateGuest.ok, true);

  if (!lateGuest.ok) {
    throw new Error("late guest join failed");
  }

  assert.deepEqual(
    lateGuest.otherParticipants.map((participant) => participant.participantId),
    ["host"],
  );

  const guestReconnect = join({
    displayName: "Guest",
    participantId: "guest",
    roomId: room.roomId,
    sessionToken: guest.participantSessionToken,
    socketId: "guest-reconnect",
  });

  assert.equal(guestReconnect.ok, true);

  if (!guestReconnect.ok) {
    throw new Error("guest reconnect failed");
  }

  assert.deepEqual(
    guestReconnect.otherParticipants
      .map((participant) => participant.participantId)
      .sort(),
    ["host", "late-guest"],
  );
});

test("host leaving ends the room", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const host = join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });

  assert.equal(host.ok, true);
  assert.deepEqual(leaveRoom(room.roomId, "host"), {
    roomEnded: true,
    participant: host.ok ? host.participant : undefined,
  });
});

test("allows only one active screen share", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
  });
  join({
    displayName: "Guest",
    participantId: "guest",
    roomCode: room.roomCode,
    roomId: room.roomId,
  });

  assert.equal(startScreenShare(room.roomId, "host", "stream-host").ok, true);
  assert.deepEqual(startScreenShare(room.roomId, "guest", "stream-guest"), {
    ok: false,
    reason: "SCREEN_SHARE_ACTIVE",
    activeParticipantId: "host",
  });
  assert.equal(stopScreenShare(room.roomId, "host").ok, true);
  assert.equal(startScreenShare(room.roomId, "guest", "stream-guest").ok, true);
  markParticipantDisconnected(room.roomId, "guest");
  assert.equal(room.activeScreenShareParticipantId, undefined);
});

test("authorizes participant-addressed signaling only between active room participants", () => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  join({
    displayName: "Host",
    isCreator: true,
    participantId: "host",
    roomId: room.roomId,
    socketId: "socket-host",
  });
  join({
    displayName: "Guest",
    participantId: "guest",
    roomCode: room.roomCode,
    roomId: room.roomId,
    socketId: "socket-guest",
  });

  assert.equal(
    isAuthorizedPeerTarget({
      room,
      senderParticipantId: "host",
      toParticipantId: "guest",
    }),
    true,
  );
  assert.equal(
    isAuthorizedPeerTarget({
      room,
      senderParticipantId: "host",
      toParticipantId: "host",
    }),
    false,
  );
  assert.equal(
    isAuthorizedPeerTarget({
      room,
      senderParticipantId: "host",
      toParticipantId: "missing",
    }),
    false,
  );

  markParticipantDisconnected(room.roomId, "guest");
  assert.equal(
    isAuthorizedPeerTarget({
      room,
      senderParticipantId: "host",
      toParticipantId: "guest",
    }),
    false,
  );
});
