"use client";

import { ArrowLeft, Flower2, Leaf, UserRound } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "@/lib/i18n";
import { normalizeDisplayName, t } from "@/lib/i18n";

export function UsernameGate({
  language,
  onBack,
  onSubmit
}: {
  language: Language;
  onBack: () => void;
  onSubmit: (displayName: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const normalizedDisplayName = normalizeDisplayName(displayName);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!normalizedDisplayName) {
      return;
    }

    onSubmit(normalizedDisplayName);
  }

  return (
    <main className="garden-scene safe-bottom grid min-h-dvh place-items-center px-6 py-8">
      <form
        onSubmit={handleSubmit}
        className="garden-panel grid w-full max-w-sm gap-5 p-5"
      >
        <button
          type="button"
          onClick={onBack}
          className="garden-button garden-button-quiet h-11 w-fit gap-2 px-3 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t(language, "back")}
        </button>

        <div className="text-center">
          <div className="garden-bubble mx-auto grid h-14 w-14 place-items-center rounded-full">
            <UserRound className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="garden-title mt-4 text-3xl">
            {t(language, "setUsernameTitle")}
          </h1>
          <p className="garden-muted mt-2 text-sm font-bold leading-relaxed">
            {t(language, "setUsernameHelp")}
          </p>
        </div>

        <label className="garden-text-muted grid gap-2 text-sm font-black">
          <span className="flex items-center gap-2">
            <Flower2 className="garden-icon-blush h-4 w-4" aria-hidden="true" />
            {t(language, "usernameLabel")}
          </span>
          <input
            autoFocus
            value={displayName}
            maxLength={32}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t(language, "usernamePlaceholder")}
            className="garden-input h-14 w-full px-4 text-lg"
          />
        </label>

        <button
          type="submit"
          disabled={!normalizedDisplayName}
          className="garden-button garden-button-primary h-16 w-full gap-2 px-5 text-xl"
        >
          {t(language, "continue")}
          <Leaf className="h-5 w-5" aria-hidden="true" />
        </button>
      </form>
    </main>
  );
}
