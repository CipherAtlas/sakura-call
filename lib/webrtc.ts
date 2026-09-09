"use client";

const defaultStunUrls = ["stun:stun.l.google.com:19302"];

function parseUrlList(value: string | undefined) {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIceServers(): RTCIceServer[] {
  const stunUrls = parseUrlList(process.env.NEXT_PUBLIC_STUN_URLS);
  return [
    { urls: stunUrls && stunUrls.length > 0 ? stunUrls : defaultStunUrls }
  ];
}

function parseIceTransportPolicy(value: string | undefined): RTCIceTransportPolicy {
  return value === "relay" ? "relay" : "all";
}

type IceServerResponse = {
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
};

type IceServerRequest = {
  roomId: string;
  participantId: string;
  participantSessionToken: string;
};

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: parseIceServers(),
    iceTransportPolicy: parseIceTransportPolicy(
      process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY
    )
  });
}

export async function refreshPeerConnectionIceServers(
  peerConnection: RTCPeerConnection,
  roomAccess: IceServerRequest
) {
  const response = await fetch("/api/ice-servers", {
    body: JSON.stringify(roomAccess),
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    return false;
  }

  const config = (await response.json()) as IceServerResponse;

  if (!Array.isArray(config.iceServers) || config.iceServers.length === 0) {
    return false;
  }

  peerConnection.setConfiguration({
    ...peerConnection.getConfiguration(),
    iceServers: config.iceServers,
    iceTransportPolicy: parseIceTransportPolicy(config.iceTransportPolicy)
  });
  return true;
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

  peerConnection.onconnectionstatechange = null;
  peerConnection.onicecandidate = null;
  peerConnection.oniceconnectionstatechange = null;
  peerConnection.onsignalingstatechange = null;
  peerConnection.ontrack = null;

  peerConnection.close();
}
