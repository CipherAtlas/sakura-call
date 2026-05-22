"use client";

import {
  ArrowLeft,
  Flower2,
  KeyRound,
  Leaf,
  Settings,
  Sparkles,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
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
  const [isOwner, setIsOwner] = useState(false);
  const [ownerAccessConfigured, setOwnerAccessConfigured] = useState(false);
  const [ownerToken, setOwnerToken] = useState("");
  const [isOwnerSigningIn, setIsOwnerSigningIn] = useState(false);
  const [ownerMessage, setOwnerMessage] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLanguage(getSavedLanguage());
    setDisplayName(getSavedDisplayName());
  }, []);

  useEffect(() => {
    let isActive = true;

    async function loadOwnerStatus() {
      try {
        const response = await fetch("/api/owner", {
          cache: "no-store"
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as {
          isOwner: boolean;
          ownerAccessConfigured: boolean;
        };

        if (!isActive) {
          return;
        }

        setIsOwner(data.isOwner);
        setOwnerAccessConfigured(data.ownerAccessConfigured);
        setHomeMode(data.isOwner ? "choose" : "join");
      } catch {
        if (isActive) {
          setHomeMode("join");
        }
      }
    }

    void loadOwnerStatus();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowSettings(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("garden-modal-open");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("garden-modal-open");
    };
  }, [showSettings]);

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

      if (response.status === 403) {
        setIsOwner(false);
        setHomeMode("join");
        setError(t(language, "hostAccessRequired"));
        return;
      }

      if (response.status === 429) {
        setError(t(language, "codeBlocked"));
        return;
      }

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

  async function handleUnlockHostMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!language || !ownerToken.trim()) {
      return;
    }

    setIsOwnerSigningIn(true);
    setOwnerMessage("");
    setError("");

    try {
      const response = await fetch("/api/owner/session", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ token: ownerToken })
      });

      if (response.status === 503) {
        setOwnerMessage(t(language, "hostAccessNotConfigured"));
        return;
      }

      if (response.status === 429) {
        setOwnerMessage(t(language, "codeBlocked"));
        return;
      }

      if (!response.ok) {
        setOwnerMessage(t(language, "hostAccessDenied"));
        return;
      }

      setIsOwner(true);
      setOwnerAccessConfigured(true);
      setOwnerToken("");
      setOwnerMessage(t(language, "hostModeEnabled"));
      setHomeMode("choose");
    } catch {
      setOwnerMessage(t(language, "hostAccessDenied"));
    } finally {
      setIsOwnerSigningIn(false);
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
    setHomeMode(isOwner ? "choose" : "join");
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

  const effectiveHomeMode = isOwner ? homeMode : "join";

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
                {effectiveHomeMode === "join"
                  ? t(language, "joinWithCode")
                  : t(language, "homeTitle")}
              </h1>
              <p className="garden-muted mt-2 max-w-sm text-sm font-bold leading-snug">
                {effectiveHomeMode === "join"
                  ? t(language, "codeHelpGuest")
                  : t(language, "homeFootnote")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                aria-label={t(language, "back")}
                onClick={
                  isOwner && effectiveHomeMode === "join"
                    ? handleBackToChoices
                    : handleBackToUsername
                }
                className="garden-icon-button grid h-11 w-11 place-items-center rounded-full"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t(language, "settings")}
                onClick={() => setShowSettings(true)}
                className="garden-icon-button grid h-11 w-11 place-items-center rounded-full"
              >
                <Settings className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </header>

          {effectiveHomeMode === "choose" ? (
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

      {showSettings ? (
        <div
          className="settings-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
          onClick={() => setShowSettings(false)}
        >
          <section
            aria-labelledby="settings-modal-title"
            aria-modal="true"
            className="settings-modal w-full max-w-sm overflow-hidden"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-ribbon" aria-hidden="true" />
            <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
              <div className="min-w-0">
                <p className="garden-kicker flex items-center gap-2">
                  <Flower2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
                  {t(language, "appName")}
                </p>
                <h2
                  className="garden-title mt-2 text-2xl"
                  id="settings-modal-title"
                >
                  {t(language, "settings")}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t(language, "closeSettings")}
                onClick={() => setShowSettings(false)}
                className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="grid gap-4 px-5 pb-5">
              <section className="settings-modal-section">
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
              </section>

              <section className="settings-modal-section">
                <p className="garden-text-muted flex items-center gap-2 text-sm font-black">
                  <KeyRound className="garden-icon-lilac h-4 w-4" aria-hidden="true" />
                  {t(language, "hostAccess")}
                </p>
                {isOwner ? (
                  <p className="garden-muted mt-2 text-sm font-black">
                    {t(language, "hostModeEnabled")}
                  </p>
                ) : ownerAccessConfigured ? (
                  <form className="mt-3 grid gap-3" onSubmit={handleUnlockHostMode}>
                    <input
                      type="password"
                      value={ownerToken}
                      onChange={(event) => setOwnerToken(event.target.value)}
                      placeholder={t(language, "hostPasscode")}
                      className="garden-input h-12 w-full px-4 text-base font-black"
                    />
                    <button
                      type="submit"
                      disabled={!ownerToken.trim() || isOwnerSigningIn}
                      className="garden-button garden-button-secondary h-12 w-full px-4 text-base"
                    >
                      {isOwnerSigningIn
                        ? t(language, "unlockingHostMode")
                        : t(language, "unlockHostMode")}
                    </button>
                  </form>
                ) : (
                  <p className="garden-muted mt-2 text-sm font-black">
                    {t(language, "hostAccessNotConfigured")}
                  </p>
                )}
                {ownerMessage ? (
                  <p className="garden-muted mt-2 text-sm font-black">
                    {ownerMessage}
                  </p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
