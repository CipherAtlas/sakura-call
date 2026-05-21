"use client";

import { ArrowLeft, Flower2, Leaf, Settings, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { saveRoomCodeForRoom } from "@/lib/roomCode";

export default function HomePage() {
  const router = useRouter();
  const [language, setLanguage] = useState<Language | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [homeMode, setHomeMode] = useState<"choose" | "join">("choose");
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLanguage(getSavedLanguage());
    setDisplayName(getSavedDisplayName());
  }, []);

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

  async function handleJoinRoom() {
    if (!/^\d{4}$/.test(roomCode) || !language) {
      return;
    }

    setIsJoining(true);
    setError("");

    try {
      const response = await fetch("/api/rooms/join", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ roomCode })
      });

      if (response.status === 429) {
        setError(t(language, "codeBlocked"));
        return;
      }

      if (response.status === 409) {
        setError(t(language, "thirdParticipantBlocked"));
        return;
      }

      if (!response.ok) {
        setError(t(language, "invalidCode"));
        return;
      }

      const data = (await response.json()) as { roomId: string };
      saveRoomCodeForRoom(data.roomId, roomCode);
      router.push(`/room/${data.roomId}`);
    } catch {
      setError(t(language, "roomNotFound"));
    } finally {
      setIsJoining(false);
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
    setHomeMode("choose");
    setError("");
  }

  function handleShowJoinRoom() {
    setHomeMode("join");
    setError("");
  }

  function handleBackToChoices() {
    setHomeMode("choose");
    setRoomCode("");
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
      <section className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-md flex-col justify-center">
        <div className="garden-panel p-4 sm:p-5">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="garden-kicker flex items-center gap-2">
                <Flower2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
                {t(language, "appName")}
              </p>
              <h1 className="garden-title mt-3 text-3xl sm:text-4xl">
                {homeMode === "join" ? t(language, "joinWithCode") : t(language, "homeTitle")}
              </h1>
              <p className="garden-muted mt-2 max-w-sm text-sm font-bold leading-snug">
                {homeMode === "join"
                  ? t(language, "codeHelpGuest")
                  : t(language, "homeFootnote")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                aria-label={t(language, "back")}
                onClick={homeMode === "join" ? handleBackToChoices : handleBackToUsername}
                className="garden-icon-button grid h-11 w-11 place-items-center rounded-full"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t(language, "settings")}
                onClick={() => setShowSettings((value) => !value)}
                className="garden-icon-button grid h-11 w-11 place-items-center rounded-full"
              >
                <Settings className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </header>

          {showSettings ? (
            <div className="mt-4 border-t border-pink-200/60 pt-4">
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

          {homeMode === "choose" ? (
            <div className="mt-5 grid gap-3">
              <button
                type="button"
                onClick={handleCreateRoom}
                disabled={isCreating}
                className="garden-button garden-button-primary h-16 w-full gap-3 px-5 text-xl"
              >
                <Sparkles className="h-5 w-5" aria-hidden="true" />
                {isCreating ? t(language, "creatingRoom") : t(language, "createRoom")}
              </button>

              <button
                type="button"
                onClick={handleShowJoinRoom}
                disabled={isCreating}
                className="garden-button garden-button-quiet h-16 w-full gap-3 px-5 text-xl"
              >
                <Leaf className="h-5 w-5" aria-hidden="true" />
                {t(language, "joinRoom")}
              </button>
            </div>
          ) : (
            <div className="mt-5">
              <label
                className="garden-text-muted flex items-center gap-2 text-sm font-black"
                htmlFor="room-code"
              >
                <Leaf className="garden-icon-lilac h-4 w-4" aria-hidden="true" />
                {t(language, "enterRoomCode")}
              </label>
              <input
                id="room-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={4}
                value={roomCode}
                onChange={(event) =>
                  setRoomCode(event.target.value.replace(/\D/g, "").slice(0, 4))
                }
                placeholder={t(language, "roomCodePlaceholder")}
                className="garden-input garden-code mt-3 h-16 w-full px-4 text-center text-3xl font-black tracking-[0.18em]"
              />
              <button
                type="button"
                disabled={!/^\d{4}$/.test(roomCode) || isJoining}
                onClick={handleJoinRoom}
                className="garden-button garden-button-secondary mt-3 h-14 w-full px-5 text-lg"
              >
                {isJoining ? t(language, "joiningRoom") : t(language, "joinRoom")}
              </button>
            </div>
          )}

          {error ? (
            <p className="garden-alert-error mt-4 rounded-lg px-4 py-3 text-sm font-black">
              {error}
            </p>
          ) : null}

          <p className="garden-muted mt-5 border-t border-pink-200/60 pt-4 text-center text-sm font-black">
            {displayName} / {languageLabel(language)}
          </p>
        </div>
      </section>
    </main>
  );
}
