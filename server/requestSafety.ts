import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export function requestIp(request: IncomingMessage) {
  const address = request.socket.remoteAddress ?? "unknown";
  const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
  const host = request.headers.host?.toLowerCase();
  const tunnelHost = process.env.CLOUDFLARE_HOSTNAME?.trim().toLowerCase();
  const cloudflareIp = request.headers["cf-connecting-ip"];

  // Only the local tunnel may supply client identity; arbitrary X-Forwarded-For is ignored.
  if (isLoopback && tunnelHost && host === tunnelHost &&
      typeof cloudflareIp === "string" && isIP(cloudflareIp)) {
    return cloudflareIp;
  }
  return address;
}

export function createRateLimiter(max: number, windowMs: number) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  let nextCleanup = 0;
  return (key: string, now = Date.now()) => {
    if (now >= nextCleanup) {
      for (const [id, state] of entries) {
        if (state.resetAt <= now) entries.delete(id);
      }
      nextCleanup = now + windowMs;
    }
    let state = entries.get(key);
    if (!state || state.resetAt <= now) {
      if (!state && entries.size >= 10_000) return false;
      state = { count: 0, resetAt: now + windowMs };
      entries.set(key, state);
    }
    if (state.count >= max) return false;
    state.count += 1;
    return true;
  };
}

// HTTP code lookup and Socket.IO joins share the same budget, including reconnects.
export const consumeJoinAttempt = createRateLimiter(20, 60_000);

export class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function readJson(request: IncomingMessage): Promise<unknown> {
  const maxBytes = 16_384;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => fail(new RequestError(408, "request-timeout")), 10_000);
    function cleanup() {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function fail(error: Error) {
      cleanup();
      request.once("error", () => undefined);
      request.resume();
      reject(error);
    }
    function onData(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        fail(new RequestError(413, "request-too-large"));
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      cleanup();
      try {
        resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
      } catch {
        reject(new RequestError(400, "invalid-json"));
      }
    }
    function onError() { fail(new RequestError(400, "request-failed")); }
    function onAborted() { fail(new RequestError(400, "request-aborted")); }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    if (Number(request.headers["content-length"]) > maxBytes) {
      fail(new RequestError(413, "request-too-large"));
    }
  });
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(body));
}

