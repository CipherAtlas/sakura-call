import { transcribeSpeech } from "../lib/transcription";
import { translateText } from "../lib/translation";
import type { Language } from "../lib/i18n";

export const captionProviders = { transcribeSpeech, translateText };

export function parseAudioSegment(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const { audio: input, isFinal, clientSegmentId } = payload as Record<string, unknown>;
  const audio = Buffer.isBuffer(input) ? input : input instanceof ArrayBuffer ? Buffer.from(input) : null;
  if (!audio || audio.length < 1000 || audio.length > 900_000 || audio.length % 2 !== 0 ||
      typeof isFinal !== "boolean" || typeof clientSegmentId !== "string" ||
      !clientSegmentId || clientSegmentId.length > 128) return null;
  // The browser emits this fixed PCM WAV format; reject arbitrary uploads before billing.
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" ||
      audio.toString("ascii", 12, 16) !== "fmt " || audio.toString("ascii", 36, 40) !== "data" ||
      audio.readUInt32LE(4) !== audio.length - 8 || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
      audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 ||
      audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.readUInt32LE(40) !== audio.length - 44) return null;
  return { audio, isFinal, clientSegmentId };
}

export async function processCaptionSegment({
  audio, language, isFinal, targetLanguages, signal, onTranscript, onTranslation
}: {
  audio: Buffer;
  language: Language;
  isFinal: boolean;
  targetLanguages: Language[];
  signal: AbortSignal;
  onTranscript?: (text: string) => void;
  onTranslation?: (language: Language, text: string) => void;
}, providers = captionProviders) {
  signal.throwIfAborted();
  const originalText = await providers.transcribeSpeech({ audio, language, isFinal, signal });
  signal.throwIfAborted();
  const translations = new Map<Language, string>();
  if (!originalText) return { originalText, translations };
  onTranscript?.(originalText);
  const languages = [...new Set(targetLanguages)];
  const results = await Promise.allSettled(languages.map(async (targetLanguage) => {
    const text = language === targetLanguage ? originalText : await providers.translateText({
      text: originalText, sourceLanguage: language, targetLanguage, signal
    });
    signal.throwIfAborted();
    if (text) onTranslation?.(targetLanguage, text);
    return text;
  }));
  signal.throwIfAborted();
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) translations.set(languages[index], result.value);
  });
  return { originalText, translations, translationFailed: results.some(result => result.status === "rejected") };
}
