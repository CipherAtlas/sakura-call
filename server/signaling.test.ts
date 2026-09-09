import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { createSignalingServer } from "./signaling";
import { createRoom, creatorCookieName, getRoom, resetRoomsForTests } from "./rooms";
import { consumeJoinAttempt } from "./requestSafety";
import type { ChatMessage } from "../lib/chat";
import type { captionProviders } from "./captions";

function nextChat(socket: Socket): Promise<[ChatMessage]> {
  return new Promise(resolve => socket.once("chat:message", message => resolve([message])));
}

function wav() {
  const buffer = Buffer.alloc(1644);
  buffer.write("RIFF"); buffer.writeUInt32LE(1636, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}

let testIp = 0;
async function fixture(t: TestContext, providers?: typeof captionProviders) {
  resetRoomsForTests();
  const previous = { NODE_ENV: process.env.NODE_ENV, CLOUDFLARE_HOSTNAME: process.env.CLOUDFLARE_HOSTNAME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.CLOUDFLARE_HOSTNAME = "call.example.com";
  process.env.OPENAI_API_KEY = "test-placeholder-no-network";
  const server = createServer();
  const io = createSignalingServer(server, providers ?? {
    transcribeSpeech: async () => { throw new Error("Unexpected provider call"); },
    translateText: async () => { throw new Error("Unexpected provider call"); }
  });
  const sockets: Socket[] = [];
  const ip = `192.0.2.${++testIp}`;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const room = createRoom({ spokenLanguage: "en" });
  t.after(async () => {
    sockets.forEach(s => s.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
    resetRoomsForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function client(host = false, origin = "https://call.example.com") {
    const socket = connect(`http://127.0.0.1:${(address as { port: number }).port}`, {
      transports: ["websocket"], forceNew: true, reconnection: false,
      extraHeaders: {
        Origin: origin, Host: "call.example.com", "CF-Connecting-IP": ip,
        ...(host ? { Cookie: `${creatorCookieName(room.roomId)}=${room.creatorSecret}` } : {})
      }
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  }
  const join = (socket: Socket, participantId: string, extra = {}) => socket.timeout(1000).emitWithAck("room:join", {
    roomId: room.roomId, roomCode: room.roomCode, participantId, displayName: participantId, spokenLanguage: "en", ...extra
  });
  return { room, client, join, ip };
}

test("socket joins reject foreign origins and invalid participant sessions", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.client(false, "https://foreign.example"));
  const guest = await f.client();
  const joined = await f.join(guest, "guest");
  assert.equal(joined.ok, true);
  const impersonator = await f.client();
  assert.equal((await f.join(impersonator, "guest", { participantSessionToken: "wrong" })).reason, "INVALID_SESSION");
  assert.equal((await f.join(guest, "ghost")).reason, "INVALID_SESSION");
  assert.equal(f.room.participants.size, 1);
  assert.equal((await f.join(impersonator, "guest", { participantSessionToken: joined.participantSessionToken })).ok, true);
});

test("HTTP and socket code attempts share a budget across reconnects and new participant IDs", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 19; i++) assert.equal(consumeJoinAttempt(f.ip), true);
  const first = await f.client();
  assert.equal((await f.join(first, "attempt-one", { roomCode: "invalid" })).reason, "INVALID_CODE");
  first.disconnect();
  const second = await f.client();
  assert.equal((await f.join(second, "attempt-two")).reason, "TOO_MANY_ATTEMPTS");
});

test("only host controls captions and malformed audio does not reach providers", { timeout: 5000 }, async t => {
  let providerCalls = 0;
  const f = await fixture(t, {
    transcribeSpeech: async () => { providerCalls++; return "Hello"; },
    translateText: async () => "Hello"
  });
  const host = await f.client(true);
  const guest = await f.client();
  await f.join(host, "host");
  await f.join(guest, "guest");
  assert.equal((await guest.timeout(1000).emitWithAck("subtitle:start-service", {})).reason, "HOST_ONLY");
  assert.equal((await host.timeout(1000).emitWithAck("subtitle:start-service", {})).ok, true);
  for (const payload of [null, {}, { audio: {} }, { audio: "bad" }, { audio: Buffer.alloc(1001), isFinal: "bad" }]) {
    guest.emit("audio:segment", payload);
  }
  // The following acknowledgement is a barrier after the invalid events.
  assert.equal((await host.timeout(1000).emitWithAck("subtitle:stop-service", {})).ok, true);
  await f.join(guest, "guest");
  assert.equal(providerCalls, 0);
  assert.equal(getRoom(f.room.roomId)?.subtitleServiceStarted, false);
});

test("stopping captions aborts in-flight transcription and prevents delivery after restart", { timeout: 5000 }, async t => {
  let release!: (text: string) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  const f = await fixture(t, {
    transcribeSpeech: async options => {
      signal = options.signal;
      started();
      return new Promise<string>(resolve => { release = resolve; });
    },
    translateText: async () => { throw new Error("Should not translate stopped captions"); }
  });
  const host = await f.client(true);
  await f.join(host, "host");
  await host.timeout(1000).emitWithAck("subtitle:start-service", {});
  let delivered = 0;
  host.on("caption:preview", () => delivered++);
  host.on("caption:error", () => delivered++);
  host.emit("audio:segment", { audio: wav(), isFinal: true, clientSegmentId: "segment" });
  await began;
  await host.timeout(1000).emitWithAck("subtitle:stop-service", {});
  assert.equal(signal?.aborted, true);
  await host.timeout(1000).emitWithAck("subtitle:start-service", {});
  release("late transcript");
  await f.join(host, "host");
  assert.equal(delivered, 0);
});

test("overlapping captions cannot publish an older result after a newer one", { timeout: 5000 }, async t => {
  const releases: ((text: string) => void)[] = [];
  let bothStarted!: () => void;
  const ready = new Promise<void>(resolve => { bothStarted = resolve; });
  const f = await fixture(t, {
    transcribeSpeech: async () => new Promise<string>(resolve => {
      releases.push(resolve);
      if (releases.length === 2) bothStarted();
    }),
    translateText: async () => "unused"
  });
  const host = await f.client(true);
  await f.join(host, "host");
  await host.timeout(1000).emitWithAck("subtitle:start-service", {});
  const delivered: string[] = [];
  host.on("caption:preview", caption => delivered.push(caption.originalText));
  host.emit("audio:segment", { audio: wav(), isFinal: true, clientSegmentId: "first" });
  host.emit("audio:segment", { audio: wav(), isFinal: true, clientSegmentId: "second" });
  await ready;
  const nextCaption = new Promise<void>(resolve => host.once("caption:preview", () => resolve()));
  releases[1]("newer");
  await nextCaption;
  releases[0]("older");
  await f.join(host, "host");
  assert.deepEqual(delivered, ["newer"]);
  host.emit("audio:segment", { audio: wav(), isFinal: true, clientSegmentId: "second" });
  await f.join(host, "host");
  assert.equal(releases.length, 2);
});

test("chat requires membership, validates text/files, and retries without duplicate delivery", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const host = await f.client(true);
  const guest = await f.client();
  assert.equal((await guest.timeout(1000).emitWithAck("chat:send", { text: "hello", clientMessageId: "a" })).ok, false);
  await f.join(host, "host");
  await f.join(guest, "guest");
  for (const input of [null, {}, { text: " ", clientMessageId: "a" }, { text: "x".repeat(4001), clientMessageId: "a" },
    { text: "", clientMessageId: "a", attachment: { id: "file", name: "large", size: 25 * 1024 * 1024 + 1 } }]) {
    assert.equal((await guest.timeout(1000).emitWithAck("chat:send", input)).ok, false);
  }
  const messages: Array<{ id: string; speakerId: string; originalText: string }> = [];
  host.on("chat:message", message => messages.push(message));
  const delivered = nextChat(host);
  const first = await guest.timeout(1000).emitWithAck("chat:send", { text: " hello ", clientMessageId: "a", speakerId: "host" });
  await delivered;
  assert.equal(first.ok, true);
  assert.equal(messages[0].speakerId, "guest");
  assert.equal(messages[0].originalText, "hello");
  const retry = await guest.timeout(1000).emitWithAck("chat:send", { text: "hello", clientMessageId: "a" });
  assert.equal(retry.message.id, first.message.id);
  assert.equal(messages.length, 1);
  const attachment = await guest.timeout(1000).emitWithAck("chat:send", { text: "", clientMessageId: "b",
    attachment: { id: "file", name: "../file.txt", size: 25 * 1024 * 1024 } });
  assert.equal(attachment.ok, true);
  assert.equal(attachment.message.attachment.name, ".._file.txt");
});

test("chat delivers original immediately and translates once per recipient language", { timeout: 5000 }, async t => {
  let release!: (value: string) => void;
  let calls = 0;
  const f = await fixture(t, {
    transcribeSpeech: async () => { throw new Error("Typed messages must not transcribe"); },
    translateText: async () => { calls++; return new Promise<string>(resolve => { release = resolve; }); }
  });
  const host = await f.client(true);
  const guest = await f.client();
  const guest2 = await f.client();
  await f.join(host, "host");
  await f.join(guest, "guest", { spokenLanguage: "ja" });
  await f.join(guest2, "guest2", { spokenLanguage: "ja" });
  await host.timeout(1000).emitWithAck("subtitle:start-service", {});
  const original = nextChat(guest);
  const original2 = nextChat(guest2);
  await host.timeout(1000).emitWithAck("chat:send", { text: "Hello", clientMessageId: "hello" });
  const [[message]] = await Promise.all([original, original2]);
  assert.equal(message.originalText, "Hello");
  assert.equal(message.translationStatus, "pending");
  assert.equal(calls, 1);
  const translated = nextChat(guest);
  const translated2 = nextChat(guest2);
  release("こんにちは");
  const [[result], [result2]] = await Promise.all([translated, translated2]);
  assert.equal(result.id, message.id);
  assert.equal(result.translatedText, "こんにちは");
  assert.equal(result2.translatedText, "こんにちは");
});

test("stopping captions preserves typed originals and marks cancelled translations unavailable", { timeout: 5000 }, async t => {
  const f = await fixture(t, {
    transcribeSpeech: async () => "",
    translateText: async ({ signal }) => new Promise<string>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  });
  const host = await f.client(true);
  const guest = await f.client();
  await f.join(host, "host");
  await f.join(guest, "guest", { spokenLanguage: "ja" });
  await host.timeout(1000).emitWithAck("subtitle:start-service", {});
  const original = nextChat(guest);
  await host.timeout(1000).emitWithAck("chat:send", { text: "Still here", clientMessageId: "hello" });
  await original;
  const cancelled = nextChat(guest);
  await host.timeout(1000).emitWithAck("subtitle:stop-service", {});
  const [message] = await cancelled;
  assert.equal(message.originalText, "Still here");
  assert.equal(message.translationStatus, "unavailable");
  const next = nextChat(guest);
  await host.timeout(1000).emitWithAck("chat:send", { text: "Chat stays on", clientMessageId: "next" });
  assert.equal((await next)[0].translationStatus, "original");
});
