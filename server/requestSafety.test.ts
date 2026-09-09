import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";

function setEnv(t: TestContext, key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}
import { createRateLimiter, readJson, RequestError, requestIp } from "./requestSafety";
import { enforceMutationOrigin, isAllowedOrigin } from "./origin";

test("rate limits survive replacement client identities and expire", () => {
  const consume = createRateLimiter(2, 1000);
  assert.equal(consume("ip", 10), true);
  assert.equal(consume("ip", 11), true);
  assert.equal(consume("ip", 12), false);
  assert.equal(consume("other-ip", 12), true);
  assert.equal(consume("ip", 1010), true);
});

test("proxy identity trusts only the configured hostname through loopback", t => {
  setEnv(t, "CLOUDFLARE_HOSTNAME", "call.example.com");
  const request = (address: string, host: string) => ({
    socket: { remoteAddress: address },
    headers: { host, "x-forwarded-for": "attacker", "cf-connecting-ip": "203.0.113.5" }
  }) as unknown as IncomingMessage;
  assert.equal(requestIp(request("127.0.0.1", "call.example.com")), "203.0.113.5");
  assert.equal(requestIp(request("127.0.0.1", "localhost")), "127.0.0.1");
  assert.equal(requestIp(request("192.0.2.1", "call.example.com")), "192.0.2.1");
});

test("production mutations reject missing, null and foreign origins", t => {
  setEnv(t, "NODE_ENV", "production");
  setEnv(t, "CLOUDFLARE_HOSTNAME", "call.example.com");
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin("null"), false);
  assert.equal(isAllowedOrigin("https://foreign.example"), false);
  assert.equal(isAllowedOrigin("https://call.example.com"), true);
});

test("HTTP rejects malformed and oversized JSON then serves the next request", async t => {
  setEnv(t, "NODE_ENV", "production");
  setEnv(t, "CLOUDFLARE_HOSTNAME", "call.example.com");
  const server = createServer((req, res) => {
    if (!enforceMutationOrigin(req, res)) return;
    void readJson(req).then(body => res.end(JSON.stringify(body))).catch(error => {
      res.statusCode = error instanceof RequestError ? error.statusCode : 500;
      res.end("rejected");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const send = (body: string, origin = "https://call.example.com") => fetch(url, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body
  });
  assert.equal((await send("{" )).status, 400);
  assert.equal((await send(JSON.stringify({ text: "a".repeat(17000) }))).status, 413);
  const chunked = await fetch(url, {
    method: "POST", headers: { origin: "https://call.example.com" }, duplex: "half",
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(17000)));
      controller.close();
    } })
  } as RequestInit & { duplex: "half" });
  assert.equal(chunked.status, 413);
  assert.equal((await send("{}", "https://foreign.example")).status, 403);
  const response = await send('{"ok":true}');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
