import OpenAI, { toFile } from "openai";
import type { Language } from "./i18n";
import { languageName } from "./i18n";

const defaultTranscriptionModel = "gpt-transcribe";
const nonEnglishScriptPattern =
  /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const hangulScriptPattern = /[\uac00-\ud7af]/u;

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

function getTranscriptionModel() {
  return process.env.TRANSCRIPTION_MODEL?.trim() || defaultTranscriptionModel;
}

export function isTranscriptionConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function transcriptionPrompt(language: Language, strict = false) {
  if (language === "en") {
    return strict
      ? "The speaker selected English and will only speak English. Transcribe only in English Latin letters. Never output Japanese, Korean, Chinese, kana, kanji, or hangul. Short reactions must be written as English words such as aww, oh, ah, huh, hmm. If the audio is unclear, return the closest English transcription only."
      : "Live private conversation. The speaker selected English and will only speak English. Transcribe natural spoken English using English Latin letters. Write short reactions as English words such as aww, oh, ah, huh, hmm.";
  }

  if (language !== "ja") {
    const name = languageName(language);

    return strict
      ? `The speaker selected ${name} and will speak ${name}. Transcribe only the spoken ${name}. If the audio is unclear, return the closest ${name} transcription only. Output only the transcript.`
      : `Live private conversation. The speaker selected ${name} and will speak ${name}. Transcribe natural spoken ${name}. Preserve casual phrasing and punctuation. Output only the transcript.`;
  }

  return strict
    ? "話者は日本語を選択しており、日本語だけを話します。自然な日本語として文字起こししてください。韓国語やハングルは出力しないでください。外来語、固有名詞、ブランド名、略語、OK、AI、Wi-Fiなど、日本語会話で自然に使われる英字表記は許可します。音声が不明瞭な場合も、最も近い日本語会話の文字起こしだけを返してください。"
    : "ライブのプライベート会話です。話者は日本語を選択しており、日本語だけを話します。自然な日本語の発話を文字起こししてください。外来語、固有名詞、ブランド名、略語、OK、AI、Wi-Fiなど、日本語会話で自然に使われる英字表記はそのまま許可します。";
}

function hasWrongScript(text: string, language: Language) {
  if (language === "en") {
    return nonEnglishScriptPattern.test(text);
  }

  if (language === "ja") {
    return hangulScriptPattern.test(text);
  }

  return false;
}

async function transcribeWithPrompt({
  audio,
  language,
  strict,
  signal
}: {
  audio: Buffer;
  language: Language;
  strict: boolean;
  signal?: AbortSignal;
}) {
  const file = await toFile(audio, `speech-${Date.now()}.wav`, {
    type: "audio/wav"
  });

  const model = getTranscriptionModel();
  // The SDK forwards these multipart fields even before its types include languages.
  const languageHint = model === "gpt-transcribe" || model.startsWith("gpt-transcribe-")
    ? { languages: [language] }
    : { language };

  const transcription = await getOpenAIClient().audio.transcriptions.create({
    file,
    model,
    ...languageHint,
    response_format: "json",
    prompt: transcriptionPrompt(language, strict)
  }, { signal, timeout: 15_000, maxRetries: 0 });

  return transcription.text?.trim() ?? "";
}

export async function transcribeSpeech({
  audio,
  language,
  isFinal,
  signal
}: {
  audio: Buffer;
  language: Language;
  isFinal: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  let text = await transcribeWithPrompt({
    audio,
    language,
    strict: false,
    signal
  });

  if (text && hasWrongScript(text, language)) {
    text = await transcribeWithPrompt({
      audio,
      language,
      strict: true,
      signal
    });
  }

  if (text && hasWrongScript(text, language)) {
    return "";
  }

  if (!isFinal && text.length < 2) {
    return "";
  }

  return text;
}
