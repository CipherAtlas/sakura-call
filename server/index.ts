import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import nextEnv from "@next/env";
import next from "next";
import { isSupportedLanguage } from "../lib/i18n";
import { parseCookies } from "./cookies";
import { createSignalingServer } from "./signaling";
import {
  createRoom,
  creatorCookieName,
  getRoom,
  isCreatorSecret,
  roomExists
} from "./rooms";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const publicHostname = process.env.CLOUDFLARE_HOSTNAME || "call.sabarg.com";
const hstsHeaderValue = "max-age=31536000; includeSubDomains";

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

function shouldUseSecureCookie(request: IncomingMessage) {
  const host = requestHost(request);

  if (forwardedProto(request) === "https") {
    return true;
  }

  return process.env.NODE_ENV === "production" && !isLocalHost(host);
}

async function handleRoomApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? hostname}`);

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const body = (await readJson(request).catch(() => null)) as {
      spokenLanguage?: unknown;
    } | null;

    if (!body || !isSupportedLanguage(body.spokenLanguage)) {
      sendJson(response, 400, { error: "invalid-language" });
      return true;
    }

    const room = createRoom(body.spokenLanguage);
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
        roomCode: room.roomCode
      },
      {
        "set-cookie": cookie
      }
    );
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
      participantCount: room?.participants.size ?? 0,
      subtitleServiceStarted: room?.subtitleServiceStarted ?? false,
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

    if (await handleRoomApi(request, response)) {
      return;
    }

    await handle(request, response);
  })();
});

createSignalingServer(httpServer);

httpServer.listen(port, () => {
  console.log(`Ready on http://${hostname}:${port}`);
});
