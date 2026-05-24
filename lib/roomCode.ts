export function roomCodeStorageKey(roomId: string) {
  return `jec.roomCode.${roomId}`;
}

export function participantSessionTokenStorageKey(roomId: string) {
  return `jec.participantSessionToken.${roomId}`;
}

export function saveRoomCodeForRoom(roomId: string, roomCode: string) {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(roomCodeStorageKey(roomId), roomCode);
  }
}

export function getSavedRoomCodeForRoom(roomId: string) {
  if (typeof window === "undefined") {
    return "";
  }

  return window.sessionStorage.getItem(roomCodeStorageKey(roomId)) ?? "";
}

export function saveParticipantSessionTokenForRoom(
  roomId: string,
  token: string
) {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(participantSessionTokenStorageKey(roomId), token);
  }
}

export function getSavedParticipantSessionTokenForRoom(roomId: string) {
  if (typeof window === "undefined") {
    return "";
  }

  return (
    window.sessionStorage.getItem(participantSessionTokenStorageKey(roomId)) ??
    ""
  );
}
