import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { transcribeSpeech } from "./transcription";

test("transcription model migration preserves the multipart API contract and failure handling", async (t) => {
  const requests: FormData[] = [];
  let responses: { status?: number; text: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request("http://localhost/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"]! },
      body: Buffer.concat(chunks)
    });
    requests.push(await request.formData());
    const response = responses.shift() ?? { status: 500, text: "Unexpected request" };
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.status ? { error: { message: response.text } } : { text: response.text }));
  });
  const originalEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    TRANSCRIPTION_MODEL: process.env.TRANSCRIPTION_MODEL
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENAI_API_KEY = "test-only";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  delete process.env.TRANSCRIPTION_MODEL;
  t.after(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const audio = Buffer.from("test audio bytes");

  await t.test("default sends only plural language hints and uploads the original audio", async () => {
    responses = [{ text: " Hello! " }];
    assert.equal(await transcribeSpeech({ audio, language: "en", isFinal: true }), "Hello!");
    const form = requests.at(-1)!;
    assert.equal(form.get("model"), "gpt-transcribe");
    assert.deepEqual(form.getAll("languages[]"), ["en"]);
    assert.equal(form.has("language"), false);
    assert.equal(form.get("response_format"), "json");
    const file = form.get("file") as File;
    assert.equal(file.type, "audio/wav");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
  });

  await t.test("Japanese script retry keeps new hints and discards persistently wrong script", async () => {
    responses = [{ text: "안녕" }, { text: "こんにちは" }];
    assert.equal(await transcribeSpeech({ audio, language: "ja", isFinal: true }), "こんにちは");
    const [first, retry] = requests.slice(-2);
    for (const form of [first, retry]) {
      assert.deepEqual(form.getAll("languages[]"), ["ja"]);
      assert.equal(form.has("language"), false);
    }
    assert.notEqual(first.get("prompt"), retry.get("prompt"));
    responses = [{ text: "안녕" }, { text: "안녕" }];
    assert.equal(await transcribeSpeech({ audio, language: "ja", isFinal: true }), "");
  });

  await t.test("explicit legacy model override retains singular language", async () => {
    process.env.TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
    try {
      responses = [{ text: "Hello" }];
      await transcribeSpeech({ audio, language: "en", isFinal: true });
      const form = requests.at(-1)!;
      assert.equal(form.get("model"), "gpt-4o-transcribe");
      assert.equal(form.get("language"), "en");
      assert.equal(form.has("languages[]"), false);
    } finally {
      delete process.env.TRANSCRIPTION_MODEL;
    }
  });

  await t.test("provider errors propagate without automatic retry or model fallback", async () => {
    const count = requests.length;
    responses = [{ status: 429, text: "Rate limited" }];
    await assert.rejects(transcribeSpeech({ audio, language: "en", isFinal: true }), /429/);
    assert.equal(requests.length, count + 1);
  });

  await t.test("cancelled caption sends no request", async () => {
    const count = requests.length;
    await assert.rejects(transcribeSpeech({ audio, language: "en", isFinal: true, signal: AbortSignal.abort() }));
    assert.equal(requests.length, count);
  });
});
