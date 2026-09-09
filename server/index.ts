import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import nextEnv from "@next/env";
import next from "next";
import { isSupportedLanguage } from "../lib/i18n";
import { parseCookies } from "./cookies";
import { enforceMutationOrigin } from "./origin";
import { consumeJoinAttempt, createRateLimiter, readJson, RequestError, requestIp, sendJson } from "./requestSafety";
import { createSignalingServer } from "./signaling";
import {
  ActiveRoomExistsError,
  createRoom,
  creatorCookieName,
  getRoom,
  getRoomByCode,
  isCreatorSecret,
  maxRoomParticipants,
  roomExists,
  type Room
} from "./rooms";
import { handleTurnApi } from "./turnRoutes";

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

const consumeOwnerLogin = createRateLimiter(8, 60_000);
const consumeRoomCreation = createRateLimiter(6, 60_000);

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
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
  response.setHeader("permissions-policy", "camera=(self), microphone=(self), display-capture=(self), speaker-selection=(self)");
  if (
    forwardedProto(request) === "https" &&
    requestHost(request) === publicHostname.toLowerCase()
  ) {
    response.setHeader("strict-transport-security", hstsHeaderValue);
  }
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

    if (!consumeOwnerLogin(requestIp(request))) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request)) as {
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

async function handleRoomApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? hostname}`);

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    if (!isOwnerRequest(request)) {
      sendJson(response, 403, { error: "owner-required" });
      return true;
    }

    if (!consumeRoomCreation(requestIp(request))) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request)) as {
      spokenLanguage?: unknown;
    } | null;

    if (!body || !isSupportedLanguage(body.spokenLanguage)) {
      sendJson(response, 400, { error: "invalid-language" });
      return true;
    }

    let room: Room;
    try {
      room = createRoom({
        spokenLanguage: body.spokenLanguage
      });
    } catch (error) {
      if (error instanceof ActiveRoomExistsError) {
        sendJson(response, 409, {
          error: "active-room-exists",
          roomId: error.room.roomId,
          roomCode: error.room.roomCode,
          maxParticipants: error.room.maxParticipants
        });
        return true;
      }

      throw error;
    }

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
    if (!consumeJoinAttempt(requestIp(request))) {
      sendJson(response, 429, { error: "too-many-attempts" });
      return true;
    }

    const body = (await readJson(request)) as {
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

    if (await handleTurnApi(request, response, isOwnerRequest)) {
      return;
    }

    if (await handleRoomApi(request, response)) {
      return;
    }

    await handle(request, response);
  })().catch((error: unknown) => {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof RequestError ? error.statusCode : 500;
    if (status === 500) console.error("HTTP request failed");
    sendJson(response, status, {
      error: error instanceof RequestError ? error.message : "internal-error"
    });
  });
});

const io = createSignalingServer(httpServer);

httpServer.requestTimeout = 15_000;
httpServer.headersTimeout = 10_000;

httpServer.listen(port, hostname, () => {
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
