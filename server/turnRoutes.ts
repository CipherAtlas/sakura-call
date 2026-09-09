import type { IncomingMessage, ServerResponse } from "node:http";
import { isRoomParticipantSession } from "./rooms";
import { getCloudflareTurnIceServers, getTurnStatus } from "./turn";
import { readJson, RequestError, sendJson } from "./requestSafety";

const defaultStunUrls = ["stun:stun.l.google.com:19302"];

function parseUrlList(value: string | undefined) {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function configuredIceServers({
  includeTurn = false,
  roomId = "",
  participantId = "",
  participantSessionToken = "",
} = {}) {
  const stunUrls = parseUrlList(process.env.NEXT_PUBLIC_STUN_URLS);
  const iceServers: RTCIceServer[] = [
    { urls: stunUrls && stunUrls.length > 0 ? stunUrls : defaultStunUrls }
  ];

  if (includeTurn && roomId && participantId && participantSessionToken) {
    try {
      const cloudflareIceServers = await getCloudflareTurnIceServers({
        roomId,
        participantId,
        participantSessionToken,
      });

      if (cloudflareIceServers) {
        return [...iceServers, ...cloudflareIceServers];
      }
    } catch {
      throw new RequestError(503, "turn-unavailable");
    }
  }

  return iceServers;
}

export async function handleTurnApi(
  request: IncomingMessage, response: ServerResponse,
  isOwnerRequest: (request: IncomingMessage) => boolean
) {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "POST" && url.pathname === "/api/ice-servers") {
    const body = (await readJson(request)) as {
      roomId?: unknown;
      participantId?: unknown;
      participantSessionToken?: unknown;
    } | null;
    const roomId = typeof body?.roomId === "string" ? body.roomId : "";
    const participantId =
      typeof body?.participantId === "string" ? body.participantId : "";
    const participantSessionToken =
      typeof body?.participantSessionToken === "string"
        ? body.participantSessionToken
        : "";

    if (
      !isRoomParticipantSession(
        roomId,
        participantId,
        body?.participantSessionToken
      )
    ) {
      sendJson(response, 403, { error: "participant-session-required" });
      return true;
    }

    sendJson(response, 200, {
      iceServers: await configuredIceServers({
        includeTurn: true,
        participantId,
        participantSessionToken,
        roomId,
      }),
      iceTransportPolicy:
        process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY === "relay"
          ? "relay"
          : "all"
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/turn/status") {
    if (!isOwnerRequest(request)) {
      sendJson(response, 403, { error: "owner-required" });
      return true;
    }

    sendJson(response, 200, getTurnStatus());
    return true;
  }

  return false;
}

