import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getCloudflareTurnIceServers } from "./turn";

function configure(t: TestContext) {
  for (const [key, value] of Object.entries({ CLOUDFLARE_TURN_TOKEN_ID: "test-key", CLOUDFLARE_TURN_API_TOKEN: "test-token" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
const access = (id: string) => ({ roomId: id, participantId: "guest", participantSessionToken: "test-session" });

test("TURN credentials deduplicate concurrent requests and filter blocked port 53", async t => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls++;
    assert.ok(options.signal);
    return Response.json({ iceServers: [
      { urls: ["turn:turn.cloudflare.com:53", "turns:turn.cloudflare.com:5349"], username: "short-lived", credential: "test-credential" },
      null, { urls: 42 }
    ] });
  });
  const [first, second] = await Promise.all([
    getCloudflareTurnIceServers(access("cache")), getCloudflareTurnIceServers(access("cache"))
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first?.[0].urls, ["turns:turn.cloudflare.com:5349"]);
  await getCloudflareTurnIceServers(access("cache"));
  assert.equal(calls, 1);
});

test("failed or malformed TURN responses are not cached and can recover", async t => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response("upstream-error", { status: 503 });
    if (calls === 2) return Response.json({ iceServers: [{ urls: "stun:example.com" }] });
    return Response.json({ iceServers: [{ urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" }] });
  });
  await assert.rejects(getCloudflareTurnIceServers(access("retry")), /503/);
  await assert.rejects(getCloudflareTurnIceServers(access("retry")), /did not include a TURN server/);
  assert.ok(await getCloudflareTurnIceServers(access("retry")));
  assert.equal(calls, 3);
});

test("stalled TURN fetch is aborted within the credential deadline", { timeout: 11000 }, async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    return new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
  });
  // Keep the test alive while AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setTimeout(() => undefined, 10000);
  try {
    await assert.rejects(getCloudflareTurnIceServers(access("timeout")), { name: "TimeoutError" });
  } finally {
    clearTimeout(keepAlive);
  }
});
