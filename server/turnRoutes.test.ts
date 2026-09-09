import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { handleTurnApi } from "./turnRoutes";
import { createRoom, joinRoom, leaveRoom, resetRoomsForTests } from "./rooms";
import { RequestError } from "./requestSafety";

test("TURN routes require owner/session authority and report upstream errors", async t => {
  resetRoomsForTests();
  const room = createRoom({ spokenLanguage: "en" });
  const joined = joinRoom({ roomId: room.roomId, participantId: "guest", socketId: "guest",
    spokenLanguage: "en", roomCode: room.roomCode, isCreator: false });
  assert.ok(joined.ok);
  for (const [key, value] of Object.entries({ CLOUDFLARE_TURN_TOKEN_ID: "route-key", CLOUDFLARE_TURN_API_TOKEN: "route-token" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let providerCalls = 0;
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(url).startsWith("http://127.0.0.1:")) return actualFetch(url, options);
    providerCalls++;
    return new Response("unavailable", { status: 503 });
  });
  const server = createServer((req, res) => {
    void handleTurnApi(req, res, request => request.headers["x-test-owner"] === "yes")
      .catch(error => { res.statusCode = error instanceof RequestError ? error.statusCode : 500; res.end("failed"); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); resetRoomsForTests(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/turn/status`)).status, 403);
  assert.equal((await fetch(`${base}/api/turn/status`, { headers: { "x-test-owner": "yes" } })).status, 200);
  const credentials = (token: string) => fetch(`${base}/api/ice-servers`, {
    method: "POST", body: JSON.stringify({ roomId: room.roomId, participantId: "guest", participantSessionToken: token })
  });
  assert.equal((await credentials("wrong")).status, 403);
  assert.equal(providerCalls, 0);
  assert.equal((await credentials(joined.participantSessionToken)).status, 503);
  assert.equal(providerCalls, 1);
  leaveRoom(room.roomId, "guest");
  assert.equal((await credentials(joined.participantSessionToken)).status, 403);
  assert.equal(providerCalls, 1);
});
