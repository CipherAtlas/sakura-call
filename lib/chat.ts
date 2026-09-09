import type { Language } from "./i18n";

export const fileSizeLimit = 25 * 1024 * 1024;
export const fileShareLimit = 100 * 1024 * 1024;

export const chatTextLimit = 4000;
export const chatLogLimit = 200;

export type ChatMessage = {
  attachment?: { id: string; name: string; size: number };
  id: string;
  roomId: string;
  speakerId: string;
  speakerName: string;
  originalLanguage: Language;
  originalText: string;
  translatedLanguage: Language;
  translatedText: string;
  translationStatus: "original" | "pending" | "translated" | "unavailable";
  timestamp: number;
};

export function upsertChatMessage(log: ChatMessage[], message: ChatMessage) {
  const index = log.findIndex(item => item.id === message.id);
  return index < 0 ? [...log, message].slice(-chatLogLimit)
    : log.map((item, position) => position === index ? message : item);
}
