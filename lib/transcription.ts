import OpenAI, { toFile } from "openai";
import type { Language } from "./i18n";

const transcriptionModel = "gpt-4o-mini-transcribe";

let client: OpenAI | null = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return client;
}

export function isTranscriptionConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function transcriptionPrompt(language: Language) {
  if (language === "en") {
    return "Live two-person conversation. Transcribe natural spoken English.";
  }

  return "ライブの二人会話です。自然な日本語の発話を文字起こししてください。";
}

export async function transcribeSpeech({
  audio,
  language,
  isFinal
}: {
  audio: Buffer;
  language: Language;
  isFinal: boolean;
}): Promise<string> {
  const file = await toFile(audio, `speech-${Date.now()}.wav`, {
    type: "audio/wav"
  });

  const transcription = await getOpenAIClient().audio.transcriptions.create({
    file,
    model: transcriptionModel,
    language,
    response_format: "json",
    prompt: transcriptionPrompt(language)
  });

  const text = transcription.text?.trim() ?? "";

  if (!isFinal && text.length < 2) {
    return "";
  }

  return text;
}
