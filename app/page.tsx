"use client";

import { ArrowLeft, Flower2, Leaf, Settings, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LanguageGate } from "@/components/LanguageGate";
import { UsernameGate } from "@/components/UsernameGate";
import {
  clearSavedDisplayName,
  clearSavedLanguage,
  getSavedDisplayName,
  getSavedLanguage,
  Language,
  languageLabel,
  saveDisplayName,
  saveLanguage,
  t
} from "@/lib/i18n";

function extractRoomId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/room\/([a-f0-9]{6})/i);
    return match?.[1] ?? "";
  } catch {
    const match = trimmed.match(/(?:room\/)?([a-f0-9]{6})/i);
    return match?.[1] ?? "";
  }
}

export default function HomePage() {
  const router = useRouter();
  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [inviteValue, setInviteValue] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLanguage(getSavedLanguage());
    setDisplayName(getSavedDisplayName());
  }, []);

  const roomId = useMemo(() => extractRoomId(inviteValue), [inviteValue]);

  async function handleCreateRoom() {
    if (!language) {
      return;
    }

    setIsCreating(true);
    setError("");

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ spokenLanguage: language })
      });

      if (!response.ok) {
        throw new Error("create-room-failed");
      }

      const data = (await response.json()) as { roomId: string };
      router.push(`/room/${data.roomId}`);
    } catch {
      setError(t(language, "createRoomFailed"));
    } finally {
      setIsCreating(false);
    }
  }

  function handleLanguageSelect(nextLanguage: Language) {
    saveLanguage(nextLanguage);
    setLanguage(nextLanguage);
  }

  function handleUsernameSubmit(nextDisplayName: string) {
    saveDisplayName(nextDisplayName);
    setDisplayName(nextDisplayName);
  }

  function handleBackToLanguage() {
    clearSavedLanguage();
    setLanguage(null);
  }

  function handleBackToUsername() {
    clearSavedDisplayName();
    setDisplayName("");
    setError("");
  }

  if (!language) {
    return <LanguageGate onSelect={handleLanguageSelect} />;
  }

  if (!displayName) {
    return (
      <UsernameGate
        language={language}
        onBack={handleBackToLanguage}
        onSubmit={handleUsernameSubmit}
      />
    );
  }

  return (
    <main className="garden-scene safe-bottom min-h-dvh px-5 py-6">
      <section className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-lg flex-col justify-between gap-5">
        <header className="garden-panel flex items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="garden-kicker flex items-center gap-2">
              <Flower2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
              {t(language, "appName")}
            </p>
            <h1 className="garden-title mt-3 text-4xl">
              {t(language, "homeTitle")}
            </h1>
            <p className="garden-muted mt-3 max-w-sm text-sm font-bold leading-relaxed">
              {t(language, "homeFootnote")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={t(language, "back")}
              onClick={handleBackToUsername}
              className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t(language, "settings")}
              onClick={() => setShowSettings((value) => !value)}
              className="garden-icon-button grid h-12 w-12 place-items-center rounded-full"
            >
              <Settings className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>

        {showSettings ? (
          <div className="garden-panel p-4">
            <p className="garden-text-muted text-sm font-black">
              {t(language, "changeLanguage")}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {(["en", "ja"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => handleLanguageSelect(code)}
                  className={`garden-button h-14 border px-4 text-lg ${
                    language === code
                      ? "garden-button-primary border-transparent"
                      : "garden-button-quiet"
                  }`}
                >
                  {languageLabel(code)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-4">
          <div className="garden-panel p-4">
            <div className="mb-4 flex items-center gap-3">
              <span className="garden-bubble grid h-10 w-10 place-items-center rounded-full">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="garden-text-ink text-sm font-black">
                  {t(language, "createRoom")}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreateRoom}
              disabled={isCreating}
              className="garden-button garden-button-primary h-16 w-full px-5 text-xl"
            >
              {isCreating ? t(language, "creatingRoom") : t(language, "createRoom")}
            </button>
          </div>

          <div className="garden-panel p-4">
            <label
              className="garden-text-muted flex items-center gap-2 text-sm font-black"
              htmlFor="invite"
            >
              <Leaf className="garden-icon-lilac h-4 w-4" aria-hidden="true" />
              {t(language, "joinWithInvite")}
            </label>
            <input
              id="invite"
              value={inviteValue}
              onChange={(event) => setInviteValue(event.target.value)}
              placeholder={t(language, "invitePlaceholder")}
              className="garden-input mt-3 h-14 w-full px-4 text-base"
            />
            <button
              type="button"
              disabled={!roomId}
              onClick={() => router.push(`/room/${roomId}`)}
              className="garden-button garden-button-secondary mt-3 h-14 w-full px-5 text-lg"
            >
              {t(language, "joinRoom")}
            </button>
          </div>

          {error ? (
            <p className="garden-alert-error rounded-lg px-4 py-3 text-sm font-black">
              {error}
            </p>
          ) : null}
        </div>

        <p className="garden-muted text-center text-sm font-black">
          {displayName} / {languageLabel(language)}
        </p>
      </section>
    </main>
  );
}
