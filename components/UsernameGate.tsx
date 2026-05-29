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
    <main className="sakura-home garden-scene entry-scene safe-bottom min-h-dvh px-5 py-6">
      <section className="sakura-home-stage entry-stage mx-auto flex min-h-[calc(100dvh-3rem)] w-full items-center justify-center">
        <form onSubmit={handleSubmit} className="sakura-shell entry-shell">
          <div className="entry-copy">
            <header className="entry-header">
              <div className="sakura-brand entry-brand">
                <Flower2 className="h-7 w-7" aria-hidden="true" />
                <span>Sakura Call</span>
              </div>
              <button
                type="button"
                onClick={onBack}
                className="garden-icon-button sakura-icon-button"
                aria-label={t(language, "back")}
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="entry-body">
              <div className="entry-bubble" aria-hidden="true">
                <UserRound className="h-10 w-10" />
              </div>
              <h1 className="garden-title entry-title">
                {t(language, "setUsernameTitle")}
              </h1>
              <p className="garden-muted entry-subtitle">
                {t(language, "setUsernameHelp")}
              </p>

              <div className="entry-form-stack">
                <label className="entry-label">
                  <span>
                    <Flower2
                      className="h-4 w-4"
                      aria-hidden="true"
                    />
                    {t(language, "usernameLabel")}
                  </span>
                  <input
                    autoFocus
                    value={displayName}
                    maxLength={32}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={t(language, "usernamePlaceholder")}
                    className="garden-input entry-input"
                  />
                </label>

                <button
                  type="submit"
                  disabled={!normalizedDisplayName}
                  className="garden-button garden-button-primary entry-submit"
                >
                  {t(language, "continue")}
                  <Leaf className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>

            <footer className="sakura-footer entry-footer">
              <span aria-hidden="true" />
              <Flower2 className="h-4 w-4" aria-hidden="true" />
              <span aria-hidden="true" />
              <p>Private room calls</p>
            </footer>
          </div>

          <div className="sakura-visual entry-visual" aria-hidden="true">
            <div className="sakura-branch" />
            <div className="sakura-bloom sakura-bloom-one" />
            <div className="sakura-bloom sakura-bloom-two" />
            <div className="sakura-bloom sakura-bloom-three" />
            <div className="sakura-petal sakura-petal-one" />
            <div className="sakura-petal sakura-petal-two" />
            <div className="sakura-petal sakura-petal-three" />
            <div className="sakura-petal sakura-petal-four" />
            <div className="sakura-leaf sakura-leaf-one" />
            <div className="sakura-leaf sakura-leaf-two" />
          </div>
        </form>
      </section>
    </main>
  );
}
