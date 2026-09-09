import { type ChatMessage, fileSizeLimit, fileShareLimit } from "./chat";

const channelPrefix = "sakura-file:";
const chunkSize = 16 * 1024;
const bufferLimit = 128 * 1024;
const idleTimeout = 30_000;

function waitForChannel(channel: RTCDataChannel, ready: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("transfer-timeout")), idleTimeout);
    function finish(error?: Error) {
      clearTimeout(timeout);
      for (const event of ["open", "bufferedamountlow", "close", "error"]) channel.removeEventListener(event, check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (channel.readyState === "closed" || channel.readyState === "closing") finish(new Error("transfer-closed"));
      else if (ready()) finish();
    }
    for (const event of ["open", "bufferedamountlow", "close", "error"]) channel.addEventListener(event, check);
    check();
  });
}

/** Files stay in the sender's browser; each download uses its own reliable data channel. */
export class FileTransfers {
  private files = new Map<string, File>();
  private channels = new Set<RTCDataChannel>();
  private outgoingPeers = new Set<string>();
  private incoming = 0;

  retain(id: string, file: File) {
    const total = [...this.files.values()].reduce((sum, item) => sum + item.size, 0);
    if (file.size > fileSizeLimit || total + file.size > fileShareLimit || this.files.size >= 100) return false;
    this.files.set(id, file);
    return true;
  }

  release(id: string) { this.files.delete(id); }

  clear() {
    for (const channel of this.channels) channel.close();
    this.channels.clear();
    this.files.clear();
  }

  async serve(channel: RTCDataChannel, peerId: string) {
    const file = this.files.get(channel.label.slice(channelPrefix.length));
    if (!channel.label.startsWith(channelPrefix) || !file || this.outgoingPeers.has(peerId)) {
      channel.close();
      return;
    }
    this.outgoingPeers.add(peerId);
    this.channels.add(channel);
    const deadline = Date.now() + 5 * 60_000;
    channel.bufferedAmountLowThreshold = bufferLimit / 2;
    let offset = 0;
    try {
      await waitForChannel(channel, () => channel.readyState === "open");
      while (offset < file.size) {
        if (channel.readyState !== "open" || Date.now() > deadline) return;
        // Backpressure keeps bulk data bounded without background-tab polling timers.
        if (channel.bufferedAmount > bufferLimit) {
          await waitForChannel(channel, () => channel.bufferedAmount <= bufferLimit / 2);
        }
        const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
        if (channel.readyState !== "open") return;
        channel.send(chunk);
        offset += chunk.byteLength;
      }
      channel.send("complete");
      channel.bufferedAmountLowThreshold = 0;
      await waitForChannel(channel, () => channel.bufferedAmount === 0);
    } catch {
      // Closing the channel tells the requester to retain the card and offer a retry.
    } finally {
      channel.close();
      this.channels.delete(channel);
      this.outgoingPeers.delete(peerId);
    }
  }

  receive(peer: RTCPeerConnection, attachment: NonNullable<ChatMessage["attachment"]>, onProgress: (percent: number) => void): Promise<Blob> {
    if (this.incoming >= 2 || attachment.size > fileSizeLimit) return Promise.reject(new Error("transfer-limit"));
    let channel: RTCDataChannel;
    try { channel = peer.createDataChannel(`${channelPrefix}${attachment.id}`, { ordered: true }); }
    catch { return Promise.reject(new Error("transfer-unavailable")); }
    this.incoming++;
    this.channels.add(channel);
    channel.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      const chunks: ArrayBuffer[] = [];
      let received = 0;
      let lastPercent = -1;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        channel.onmessage = null;
        channel.onclose = null;
        channel.onerror = null;
        channel.close();
        this.channels.delete(channel);
        this.incoming--;
        if (success) resolve(new Blob(chunks, { type: "application/octet-stream" }));
        else reject(new Error("transfer-interrupted"));
      };
      const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => finish(false), idleTimeout); };
      touch();
      channel.onclose = () => finish(false);
      channel.onerror = () => finish(false);
      channel.onmessage = event => {
        touch();
        if (event.data === "complete") {
          if (received === attachment.size) onProgress(100);
          return finish(received === attachment.size);
        }
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > chunkSize || received + event.data.byteLength > attachment.size) {
          return finish(false);
        }
        chunks.push(event.data);
        received += event.data.byteLength;
        const percent = attachment.size ? Math.floor(received / attachment.size * 100) : 100;
        if (percent !== lastPercent) { lastPercent = percent; onProgress(percent); }
      };
    });
  }
}
