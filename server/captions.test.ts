import assert from "node:assert/strict";
import test from "node:test";
import { processCaptionSegment } from "./captions";

test("caption translations deduplicate languages and isolate a language failure", async () => {
  const languages: string[] = [];
  const result = await processCaptionSegment({
    audio: Buffer.alloc(1001), language: "en", isFinal: true,
    targetLanguages: ["en", "ja", "ja", "ko"], signal: new AbortController().signal
  }, {
    transcribeSpeech: async () => "Hello",
    translateText: async ({ targetLanguage }) => {
      languages.push(targetLanguage);
      if (targetLanguage === "ko") throw new Error("unavailable");
      return "こんにちは";
    }
  });
  assert.deepEqual(languages.sort(), ["ja", "ko"]);
  assert.equal(result.translations.get("en"), "Hello");
  assert.equal(result.translations.get("ja"), "こんにちは");
  assert.equal(result.translationFailed, true);
});

test("aborted caption work never calls a provider", async () => {
  await assert.rejects(processCaptionSegment({
    audio: Buffer.alloc(1001), language: "en", isFinal: true,
    targetLanguages: [], signal: AbortSignal.abort()
  }, {
    transcribeSpeech: async () => { assert.fail("unexpected provider call"); },
    translateText: async () => { assert.fail("unexpected provider call"); }
  }), { name: "AbortError" });
});

test("preview and same-language captions do not wait for a slower translation", async () => {
  const events: string[] = [];
  let release!: (text: string) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = processCaptionSegment({
    audio: Buffer.alloc(1001), language: "en", isFinal: true,
    targetLanguages: ["en", "ja"], signal: new AbortController().signal,
    onTranscript: () => events.push("preview"),
    onTranslation: language => events.push(language)
  }, {
    transcribeSpeech: async () => "Hello",
    translateText: async () => { started(); return new Promise<string>(resolve => { release = resolve; }); }
  });
  await began;
  assert.deepEqual(events, ["preview", "en"]);
  release("こんにちは");
  await pending;
  assert.deepEqual(events, ["preview", "en", "ja"]);
});
