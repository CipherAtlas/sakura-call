import OpenAI from "openai";
import type { Language } from "./i18n";
import { languageName } from "./i18n";

const defaultTranslationModel = "gpt-4o-mini";

const systemInstruction =
  "Translate the speaker’s meaning naturally for a live conversation. Preserve tone, intent, politeness, emotion, and casual phrasing where appropriate. Do not translate word-for-word. Output only the translated sentence.";

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

export async function translateText({
  text,
  sourceLanguage,
  targetLanguage
}: {
  text: string;
  sourceLanguage: Language;
  targetLanguage: Language;
}): Promise<string> {
  const model = process.env.TRANSLATION_MODEL || defaultTranslationModel;

  const response = await getOpenAIClient().chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: systemInstruction
      },
      {
        role: "user",
        content: `Translate from ${languageName(sourceLanguage)} to ${languageName(
          targetLanguage
        )}:\n\n${text}`
      }
    ]
  });

  return response.choices[0]?.message.content?.trim() ?? "";
}
