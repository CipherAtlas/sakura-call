"use client";

import {
  ArrowLeft,
  Flower2,
  KeyRound,
  Leaf,
  LogOut,
  Settings,
  Sparkles,
  TowerControl,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { LanguageGate } from "@/components/LanguageGate";
import { UsernameGate } from "@/components/UsernameGate";
import {
  clearSavedDisplayName,
  clearSavedLanguage,
  getSavedDisplayName,
  getSavedLanguage,
  isSupportedLanguage,
  Language,
  languageLabel,
  saveDisplayName,
  saveLanguage,
  supportedLanguageOptions,
  t
} from "@/lib/i18n";
import { saveRoomCodeForRoom } from "@/lib/roomCode";

type TurnPhase =
  | "disabled"
  | "ready"
  | "error";

type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  provider?: string;
  host?: string;
  expiresAt?: number;
  updatedAt: number;
};

function turnStatusLabel(language: Language, status: TurnStatus | null) {
  switch (status?.phase) {
    case "disabled":
      return t(language, "turnRelayNotConfigured");
    case "ready":
      return t(language, "turnRelayReady");
    case "error":
      return t(language, "turnRelayError");
    default:
      return t(language, "turnRelayOff");
  }
}

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
  const [isOwnerSigningOut, setIsOwnerSigningOut] = useState(false);
  const [ownerMessage, setOwnerMessage] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");
  const [turnStatus, setTurnStatus] = useState<TurnStatus | null>(null);

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

  const loadTurnStatus = useCallback(async () => {
    const response = await fetch("/api/turn/status", {
      cache: "no-store",
      credentials: "include"
    });

    if (!response.ok) {
      return null;
    }

    const nextStatus = (await response.json()) as TurnStatus;
    setTurnStatus(nextStatus);
    return nextStatus;
  }, []);

  useEffect(() => {
    if (!isOwner) {
      setTurnStatus(null);
      return;
    }

    void loadTurnStatus().catch(() => undefined);
  }, [isOwner, loadTurnStatus]);

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
        body: JSON.stringify({
          spokenLanguage: language
        })
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
      setOwnerMessage("");
      setHomeMode("choose");
    } catch {
      setOwnerMessage(t(language, "hostAccessDenied"));
    } finally {
      setIsOwnerSigningIn(false);
    }
  }

  async function handleDisableHostMode() {
    if (!language) {
      return;
    }

    setIsOwnerSigningOut(true);
    setOwnerMessage("");
    setError("");

    try {
      const response = await fetch("/api/owner/session", {
        method: "DELETE"
      });

      if (!response.ok) {
        setOwnerMessage(t(language, "hostAccessDenied"));
        return;
      }

      setIsOwner(false);
      setOwnerToken("");
      setHomeMode("join");
      setOwnerMessage(t(language, "hostModeDisabled"));
    } catch {
      setOwnerMessage(t(language, "hostAccessDenied"));
    } finally {
      setIsOwnerSigningOut(false);
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

  const turnRelayReady = turnStatus?.phase === "ready";
  const createRoomLabel = t(language, "createRoom");
  const joinRoomLabel = t(language, "joinRoom");
  const homeFootnote = t(language, "homeFootnote");
  const turnRelayPanel = isOwner ? (
    <section className="settings-modal-section turn-relay-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <TowerControl className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="garden-text-ink text-base font-black">
              {t(language, "turnRelayTitle")}
            </h2>
            <span
              className={`turn-relay-pill ${
                turnRelayReady ? "is-ready" : turnStatus?.phase === "error" ? "is-error" : ""
              }`}
            >
              {turnStatusLabel(language, turnStatus)}
            </span>
          </div>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {turnRelayReady
              ? t(language, "turnRelayReadyHelp")
              : t(language, "turnRelayHelp")}
          </p>
          {turnStatus?.provider ? (
            <p className="garden-muted mt-2 truncate text-xs font-black">
              {turnStatus.provider}
            </p>
          ) : null}
          {turnStatus?.host ? (
            <p className="garden-muted mt-1 truncate text-xs font-black">
              {turnStatus.host}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  ) : null;

  return (
    <main className="sakura-home garden-scene safe-bottom min-h-dvh px-5 py-6">
      <section className="sakura-home-stage mx-auto flex min-h-[calc(100dvh-3rem)] w-full items-center justify-center">
        <div className="sakura-shell">
          <div className="sakura-copy">
            <header className="sakura-header">
              <p className="sakura-brand">
                <Flower2 className="h-6 w-6" aria-hidden="true" />
                {t(language, "appName")}
              </p>
              <div className="sakura-actions">
                <button
                  type="button"
                  aria-label={t(language, "back")}
                  onClick={
                    isOwner && effectiveHomeMode === "join"
                      ? handleBackToChoices
                      : handleBackToUsername
                  }
                  className="garden-icon-button sakura-icon-button"
                >
                  <ArrowLeft className="h-6 w-6" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={t(language, "settings")}
                  onClick={() => setShowSettings(true)}
                  className="garden-icon-button sakura-icon-button"
                >
                  <Settings className="h-6 w-6" aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="sakura-body">
              <h1 className="garden-title sakura-title">
                {effectiveHomeMode === "join"
                  ? t(language, "joinWithCode")
                  : t(language, "homeTitle")}
              </h1>
              <p className="garden-muted sakura-subtitle">
                {effectiveHomeMode === "join"
                  ? t(language, "codeHelpGuest")
                  : homeFootnote}
              </p>

              {effectiveHomeMode === "choose" ? (
                <div className="sakura-control-stack">
                  <button
                    type="button"
                    onClick={handleCreateRoom}
                    disabled={isCreating}
                    className="garden-button garden-button-primary sakura-primary-button"
                  >
                    <Sparkles className="h-6 w-6" aria-hidden="true" />
                    {isCreating
                      ? t(language, "creatingRoom")
                      : createRoomLabel}
                  </button>

                  <button
                    type="button"
                    onClick={handleShowJoinRoom}
                    disabled={isCreating}
                    className="garden-button garden-button-quiet sakura-secondary-button"
                  >
                    <Leaf className="h-6 w-6" aria-hidden="true" />
                    {joinRoomLabel}
                  </button>
                </div>
              ) : (
                <div className="sakura-control-stack">
                  <label className="sakura-code-label" htmlFor="room-code">
                    <Leaf className="h-5 w-5" aria-hidden="true" />
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
                      setRoomCode(
                        event.target.value.replace(/\D/g, "").slice(0, 4)
                      )
                    }
                    placeholder={t(language, "roomCodePlaceholder")}
                    className="garden-input garden-code sakura-code-input"
                  />
                  <button
                    type="button"
                    disabled={!/^\d{4}$/.test(roomCode) || isJoining}
                    onClick={handleJoinRoom}
                    className="garden-button garden-button-primary sakura-primary-button"
                  >
                    {isJoining ? t(language, "joiningRoom") : joinRoomLabel}
                  </button>
                </div>
              )}

              {error ? (
                <p className="garden-alert-error sakura-error">{error}</p>
              ) : null}
            </div>

            <footer className="sakura-footer">
              <span />
              <Flower2 className="h-5 w-5" aria-hidden="true" />
              <span />
              <p>
                {displayName} / {languageLabel(language)}
              </p>
            </footer>
          </div>

          <div className="sakura-visual" aria-hidden="true">
            <span className="sakura-branch" />
            <span className="sakura-bloom sakura-bloom-one" />
            <span className="sakura-bloom sakura-bloom-two" />
            <span className="sakura-bloom sakura-bloom-three" />
            <span className="sakura-petal sakura-petal-one" />
            <span className="sakura-petal sakura-petal-two" />
            <span className="sakura-petal sakura-petal-three" />
            <span className="sakura-petal sakura-petal-four" />
            <span className="sakura-leaf sakura-leaf-one" />
            <span className="sakura-leaf sakura-leaf-two" />
          </div>
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
            className="settings-modal max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-hidden"
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

            <div className="settings-modal-content grid gap-4 px-5 pb-5">
              <section className="settings-modal-section">
                <p className="garden-text-muted text-sm font-black">
                  {t(language, "changeLanguage")}
                </p>
                <select
                  value={language}
                  onChange={(event) => {
                    const nextLanguage = event.target.value;

                    if (isSupportedLanguage(nextLanguage)) {
                      handleLanguageSelect(nextLanguage);
                    }
                  }}
                  className="garden-select settings-language-select"
                >
                  {supportedLanguageOptions.map(({ code, label }) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </section>

              <section className="settings-modal-section">
                <p className="garden-text-muted flex items-center gap-2 text-sm font-black">
                  <KeyRound className="garden-icon-lilac h-4 w-4" aria-hidden="true" />
                  {t(language, "hostAccess")}
                </p>
                {isOwner ? (
                  <div className="mt-3 grid gap-3">
                    <p className="garden-muted text-sm font-black">
                      {t(language, "hostModeEnabled")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleDisableHostMode()}
                      disabled={isOwnerSigningOut}
                      className="garden-button garden-button-quiet h-12 gap-2 px-4 text-base"
                    >
                      <LogOut className="h-5 w-5" aria-hidden="true" />
                      {isOwnerSigningOut
                        ? t(language, "disablingHostMode")
                        : t(language, "disableHostMode")}
                    </button>
                  </div>
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

              {turnRelayPanel}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
