import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import nextEnv from "@next/env";
import next from "next";
import { isSupportedLanguage } from "../lib/i18n";
import { parseCookies } from "./cookies";
import { enforceMutationOrigin } from "./origin";
import { createSignalingServer } from "./signaling";
import {
  createRoom,
  creatorCookieName,
  getRoom,
  getRoomByCode,
  isCreatorSecret,
  isRoomParticipantSession,
  maxRoomParticipants,
  roomExists
} from "./rooms";
import {
  getCloudflareTurnIceServers,
  getTurnStatus,
} from "./turn";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const publicHostname = process.env.CLOUDFLARE_HOSTNAME || "call.sabarg.com";
const hstsHeaderValue = "max-age=31536000; includeSubDomains";
const ownerCookieName = "jec_owner";
const shutdownNoticeGraceMs = Number(process.env.SHUTDOWN_NOTICE_GRACE_MS || 750);
const ownerAccessToken = process.env.ROOM_OWNER_TOKEN || "";
const ownerSessionSecret =
  process.env.ROOM_OWNER_SESSION_SECRET || ownerAccessToken;
const ownerSessionMaxAge = 60 * 60 * 24 * 14;
const defaultStunUrls = ["stun:stun.l.google.com:19302"];

type RateLimitState = {
  count: number;
  resetAt: number;
};

const joinCodeRateLimits = new Map<string, RateLimitState>();
const createRoomRateLimits = new Map<string, RateLimitState>();
const ownerLoginRateLimits = new Map<string, RateLimitState>();

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requestHost(request: IncomingMessage) {
  return headerValue(request.headers.host)?.split(":")[0]?.toLowerCase() ?? "";
}

function forwardedProto(request: IncomingMessage) {
  return headerValue(request.headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
}

function requestIp(request: IncomingMessage) {
  const forwardedFor = headerValue(request.headers["x-forwarded-for"]);
  return (
    forwardedFor?.split(",")[0]?.trim() ??
    request.socket.remoteAddress ??
    "unknown"
  );
}

function consumeRateLimit(
  bucket: Map<string, RateLimitState>,
  key: string,
  max: number,
  windowMs: number
) {
  const now = Date.now();
  const state = bucket.get(key);

  if (!state || state.resetAt <= now) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (state.count >= max) {
    return false;
  }

  state.count += 1;
  return true;
}

function ownerSessionValue() {
  if (!ownerAccessToken || !ownerSessionSecret) {
    return "";
  }

  return crypto
    .createHmac("sha256", ownerSessionSecret)
    .update(ownerAccessToken)
    .digest("base64url");
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isOwnerRequest(request: IncomingMessage) {
  const expected = ownerSessionValue();

  if (!expected) {
    return false;
  }

  const cookies = parseCookies(request.headers.cookie);
  const actual = cookies[ownerCookieName];

  return Boolean(actual && constantTimeEqual(actual, expected));
}

function ownerSessionCookie(request: IncomingMessage) {
  return `${ownerCookieName}=${encodeURIComponent(
    ownerSessionValue()
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ownerSessionMaxAge}${
    shouldUseSecureCookie(request) ? "; Secure" : ""
  }`;
}

function clearOwnerSessionCookie(request: IncomingMessage) {
  return `${ownerCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${
    shouldUseSecureCookie(request) ? "; Secure" : ""
  }`;
}

function isLocalHost(host: string) {
  return (
    /^localhost$/i.test(host) ||
    /^127\.0\.0\.1$/.test(host) ||
    host === "::1" ||
    host === "[::1]"
  );
}

function shouldRedirectToHttps(request: IncomingMessage) {
  const host = requestHost(request);

  return (
    host === publicHostname.toLowerCase() &&
    forwardedProto(request) !== "https"
  );
}

function redirectToHttps(request: IncomingMessage, response: ServerResponse) {
  const host = request.headers.host ?? publicHostname;
  const location = new URL(request.url ?? "/", `https://${host}`);
  response.writeHead(308, { location: location.toString() });
  response.end();
}

function applySecurityHeaders(request: IncomingMessage, response: ServerResponse) {
  if (
    forwardedProto(request) === "https" &&
    requestHost(request) === publicHostname.toLowerCase()
  ) {
    response.setHeader("strict-transport-security", hstsHeaderValue);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers
  });
  response.end(JSON.stringify(body));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function closeHttpServer() {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    timeout.unref();

    httpServer.close((error) => {
      clearTimeout(timeout);
      if (error) {
        console.error("HTTP server close failed:", error);
      }
      resolve();
    });
  });
}

function shouldUseSecureCookie(request: IncomingMessage) {
  const host = requestHost(request);

  if (forwardedProto(request) === "https") {
    return true;
  }

  return process.env.NODE_ENV === "production" && !isLocalHost(host);
}

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
        return cloudflareIceServers;
      }
    } catch (error) {
      console.error("Cloudflare TURN credential generation failed:", error);
    }
  }

  return iceServers;
}

async function handleOwnerApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? hostname}`);

  if (request.method === "GET" && url.pathname === "/api/owner") {
    sendJson(response, 200, {
      isOwner: isOwnerRequest(request),
      ownerAccessConfigured: Boolean(ownerAccessToken)
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/owner/session") {
    if (!ownerAccessToken) {
      sendJson(response, 503, { error: "owner-access-not-configured" });
      return true;
    }

    if (
      !consumeRateLimit(
        ownerLoginRateLimits,
        `owner-login:${requestIp(request)}`,
        8,
        60_000
      )
    ) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request).catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token : "";

    if (!constantTimeEqual(token, ownerAccessToken)) {
      sendJson(response, 401, { error: "invalid-owner-token" });
      return true;
    }

    sendJson(
      response,
      200,
      { isOwner: true },
      {
        "set-cookie": ownerSessionCookie(request)
      }
    );
    return true;
  }

  if (request.method === "DELETE" && url.pathname === "/api/owner/session") {
    sendJson(
      response,
      200,
      { isOwner: false },
      {
        "set-cookie": clearOwnerSessionCookie(request)
      }
    );
    return true;
  }

  return false;
}

async function handleTurnApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? hostname}`);

  if (request.method === "POST" && url.pathname === "/api/ice-servers") {
    const body = (await readJson(request).catch(() => null)) as {
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

async function handleRoomApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? hostname}`);

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    if (!isOwnerRequest(request)) {
      sendJson(response, 403, { error: "owner-required" });
      return true;
    }

    if (
      !consumeRateLimit(
        createRoomRateLimits,
        `create-room:${requestIp(request)}`,
        6,
        60_000
      )
    ) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request).catch(() => null)) as {
      spokenLanguage?: unknown;
    } | null;

    if (!body || !isSupportedLanguage(body.spokenLanguage)) {
      sendJson(response, 400, { error: "invalid-language" });
      return true;
    }

    const room = createRoom({
      spokenLanguage: body.spokenLanguage
    });
    const cookie = `${creatorCookieName(room.roomId)}=${encodeURIComponent(
      room.creatorSecret
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 4}${
      shouldUseSecureCookie(request) ? "; Secure" : ""
    }`;

    sendJson(
      response,
      200,
      {
        roomId: room.roomId,
        roomCode: room.roomCode,
        maxParticipants: room.maxParticipants
      },
      {
        "set-cookie": cookie
      }
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/rooms/join") {
    if (
      !consumeRateLimit(
        joinCodeRateLimits,
        `join-code:${requestIp(request)}`,
        12,
        60_000
      )
    ) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request).catch(() => null)) as {
      roomCode?: unknown;
    } | null;
    const roomCode =
      typeof body?.roomCode === "string"
        ? body.roomCode.replace(/\D/g, "").slice(0, 4)
        : "";

    if (!/^\d{4}$/.test(roomCode)) {
      sendJson(response, 400, { error: "invalid-code" });
      return true;
    }

    const room = getRoomByCode(roomCode);

    if (!room) {
      sendJson(response, 404, { error: "room-not-found" });
      return true;
    }

    if (room.participants.size >= room.maxParticipants) {
      sendJson(response, 409, { error: "room-full" });
      return true;
    }

    sendJson(response, 200, { roomId: room.roomId });
    return true;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{6})$/i);

  if (request.method === "GET" && roomMatch) {
    const roomId = roomMatch[1] ?? "";

    if (!roomExists(roomId)) {
      sendJson(response, 404, { error: "room-not-found" });
      return true;
    }

    const room = getRoom(roomId);
    const cookies = parseCookies(request.headers.cookie);
    const isCreator = isCreatorSecret(roomId, cookies[creatorCookieName(roomId)]);

    sendJson(response, 200, {
      roomId,
      exists: true,
      isCreator,
      maxParticipants: room?.maxParticipants ?? maxRoomParticipants,
      participantCount: room?.participants.size ?? 0,
      subtitleServiceStarted: room?.subtitleServiceStarted ?? false,
      activeScreenShareParticipantId: room?.activeScreenShareParticipantId,
      roomCode: isCreator ? room?.roomCode : undefined
    });
    return true;
  }

  return false;
}

await app.prepare();

const httpServer = createServer((request, response) => {
  void (async () => {
    if (shouldRedirectToHttps(request)) {
      redirectToHttps(request, response);
      return;
    }

    applySecurityHeaders(request, response);

    if (!enforceMutationOrigin(request, response)) {
      return;
    }

    if (await handleOwnerApi(request, response)) {
      return;
    }

    if (await handleTurnApi(request, response)) {
      return;
    }

    if (await handleRoomApi(request, response)) {
      return;
    }

    await handle(request, response);
  })();
});

const io = createSignalingServer(httpServer);

httpServer.listen(port, () => {
  console.log(`Ready on http://${hostname}:${port}`);
});

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`Received ${signal}; notifying clients and shutting down.`);

    void (async () => {
      io.emit("room:ended", {
        endedBy: "server-shutdown",
        reason: "server-shutdown",
        timestamp: Date.now()
      });
      io.emit("server:shutdown", {
        reason: "server-shutdown",
        timestamp: Date.now()
      });
      await sleep(Math.max(0, shutdownNoticeGraceMs));
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await closeHttpServer();
    })()
      .catch((error) => {
        console.error("Shutdown failed:", error);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
