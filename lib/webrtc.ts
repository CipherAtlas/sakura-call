"use client";

function parseIceUrls(value: string | undefined): RTCIceServer[] {
  if (!value) {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }

  const urls = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return urls.length > 0 ? [{ urls }] : [{ urls: "stun:stun.l.google.com:19302" }];
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: parseIceUrls(process.env.NEXT_PUBLIC_STUN_URLS),
    iceTransportPolicy: "all"
  });
}

export function addStreamTracks(
  peerConnection: RTCPeerConnection,
  stream: MediaStream
) {
  const existingTrackIds = new Set(
    peerConnection.getSenders().map((sender) => sender.track?.id)
  );

  for (const track of stream.getTracks()) {
    if (!existingTrackIds.has(track.id)) {
      peerConnection.addTrack(track, stream);
    }
  }
}

export function closePeerConnection(peerConnection: RTCPeerConnection | null) {
  if (!peerConnection) {
    return;
  }

  peerConnection.close();
}
