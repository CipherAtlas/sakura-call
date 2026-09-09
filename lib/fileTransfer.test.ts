import assert from "node:assert/strict";
import test from "node:test";
import { FileTransfers } from "./fileTransfer";
import { fileSizeLimit, upsertChatMessage, type ChatMessage } from "./chat";

class Channel extends EventTarget {
  label = "sakura-file:file";
  readyState = "open";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  remote?: Channel;
  send(data: unknown) { queueMicrotask(() => this.remote?.onmessage?.({ data })); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    queueMicrotask(() => this.onclose?.());
    if (this.remote && this.remote.readyState !== "closed") this.remote.close();
  }
}

function connection() {
  const local = new Channel();
  const remote = new Channel();
  local.remote = remote; remote.remote = local;
  return { local, remote, peer: { createDataChannel: () => local } as unknown as RTCPeerConnection };
}

test("25 MiB file transfer reconstructs binary chunks and reports real progress", async () => {
  const sender = new FileTransfers();
  const receiver = new FileTransfers();
  const bytes = Uint8Array.from({ length: fileSizeLimit }, (_, index) => index % 256);
  assert.equal(sender.retain("file", new File([bytes], "test.bin")), true);
  const { peer, remote } = connection();
  const progress: number[] = [];
  const download = receiver.receive(peer, { id: "file", name: "test.bin", size: bytes.length }, value => progress.push(value));
  await sender.serve(remote as unknown as RTCDataChannel, "peer");
  assert.deepEqual(new Uint8Array(await (await download).arrayBuffer()), bytes);
  assert.ok(progress.length > 1);
  assert.ok(progress.some(value => value > 0 && value < 100));
  assert.equal(progress.at(-1), 100);
  sender.clear(); receiver.clear();
});

test("file transfer rejects missing, oversized, truncated, and disconnected transfers", async () => {
  const sender = new FileTransfers();
  assert.equal(sender.retain("too-large", new File([new Uint8Array(fileSizeLimit + 1)], "large")), false);
  for (const mode of ["missing", "truncated", "oversized", "disconnected"] as const) {
    const receiver = new FileTransfers();
    const { peer, remote } = connection();
    const rejected = assert.rejects(receiver.receive(peer, { id: "file", name: "test", size: 2 }, () => {}));
    if (mode === "missing") await sender.serve(remote as unknown as RTCDataChannel, "peer");
    if (mode === "truncated") remote.send("complete");
    if (mode === "oversized") remote.send(new ArrayBuffer(3));
    if (mode === "disconnected") remote.close();
    await rejected;
    receiver.clear();
  }
});

test("clearing shared files makes subsequent downloads unavailable", async () => {
  const sender = new FileTransfers();
  sender.retain("file", new File([], "empty"));
  sender.clear();
  const { remote } = connection();
  await sender.serve(remote as unknown as RTCDataChannel, "peer");
  assert.equal(remote.readyState, "closed");
});

test("translation updates replace a chat bubble without moving it or duplicating it", () => {
  const message: ChatMessage = { id: "1", roomId: "room", speakerId: "a", speakerName: "A", originalText: "hello",
    originalLanguage: "en", translatedLanguage: "ja", translatedText: "", translationStatus: "pending", timestamp: 1 };
  const log = upsertChatMessage([message, { ...message, id: "2", timestamp: 2 }], { ...message, translatedText: "こんにちは", translationStatus: "translated" });
  assert.deepEqual(log.map(item => item.id), ["1", "2"]);
  assert.equal(log[0].translatedText, "こんにちは");
});


test("file sender waits for backpressure to drain before sending", async () => {
  const sender = new FileTransfers();
  sender.retain("file", new File(["hello"], "test"));
  const { remote, local } = connection();
  remote.bufferedAmount = 256 * 1024;
  let received = 0;
  local.onmessage = () => received++;
  const sending = sender.serve(remote as unknown as RTCDataChannel, "peer");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received, 0);
  remote.bufferedAmount = 0;
  remote.dispatchEvent(new Event("bufferedamountlow"));
  await sending;
  assert.equal(received, 2);
});
