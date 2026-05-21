"use client";

import { Copy, Flower2, Link2 } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export function RoomCodeModal({
  language,
  roomCode,
  inviteUrl,
  codeValue,
  isCreator,
  copiedTarget,
  onCodeChange,
  onCopyInvite,
  onCopyCode
}: {
  language: Language;
  roomCode?: string;
  inviteUrl: string;
  codeValue: string;
  isCreator: boolean;
  copiedTarget: "invite" | "code" | null;
  onCodeChange: (value: string) => void;
  onCopyInvite: () => void;
  onCopyCode: () => void;
}) {
  return (
    <section className="garden-panel p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="garden-text-ink flex items-center gap-2 text-lg font-black">
            <Flower2 className="garden-icon-blush h-5 w-5 shrink-0" aria-hidden="true" />
            {t(language, "roomSetup")}
          </h2>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {isCreator ? t(language, "codeHelpCreator") : t(language, "codeHelpGuest")}
          </p>
        </div>
      </div>

      {isCreator && roomCode ? (
        <div className="mt-4 grid gap-3">
          <div className="garden-code-surface rounded-lg p-4 ring-1">
            <p className="garden-text-muted text-sm font-black">
              {t(language, "roomCode")}
            </p>
            <p className="garden-code mt-1 text-5xl font-black tracking-[0.12em]">
              {roomCode}
            </p>
          </div>

          <div className="garden-invite-surface rounded-lg p-3 ring-1">
            <p className="garden-text-muted flex items-center gap-2 text-sm font-black">
              <Link2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
              {t(language, "inviteLink")}
            </p>
            <p className="garden-text-ink mt-2 truncate text-sm font-bold">
              {inviteUrl || "..."}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={onCopyInvite}
              className="garden-button garden-button-secondary h-12 gap-2 px-4 text-base"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {copiedTarget === "invite"
                ? t(language, "copied")
                : t(language, "copyInviteLink")}
            </button>
            <button
              type="button"
              onClick={onCopyCode}
              className="garden-button garden-button-blush h-12 gap-2 px-4 text-base"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {copiedTarget === "code"
                ? t(language, "copied")
                : t(language, "copyRoomCode")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label
            htmlFor="room-code"
            className="garden-text-muted text-sm font-black"
          >
            {t(language, "enterRoomCode")}
          </label>
          <input
            id="room-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={4}
            value={codeValue}
            onChange={(event) =>
              onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 4))
            }
            className="garden-input garden-code mt-3 h-16 w-full px-4 text-center text-3xl font-black tracking-[0.18em]"
          />
        </div>
      )}
    </section>
  );
}
