"use client";

import { Flower2, Leaf } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { languageLabel } from "@/lib/i18n";

export function LanguageGate({
  onSelect
}: {
  onSelect: (language: Language) => void;
}) {
  const languageOptions = [
    {
      language: "en",
      detail: "Use English"
    },
    {
      language: "ja",
      detail: "日本語で使う"
    }
  ] as const;

  return (
    <main className="sakura-home garden-scene entry-scene safe-bottom min-h-dvh px-5 py-6">
      <section className="sakura-home-stage entry-stage mx-auto flex min-h-[calc(100dvh-3rem)] w-full items-center justify-center">
        <div className="sakura-shell entry-shell">
          <div className="entry-copy">
            <header className="entry-header">
              <div className="sakura-brand entry-brand">
                <Flower2 className="h-7 w-7" aria-hidden="true" />
                <span>Sakura Call</span>
              </div>
            </header>

            <div className="entry-body">
              <div className="entry-bubble" aria-hidden="true">
                <Flower2 className="h-10 w-10" />
              </div>
              <h1 className="garden-title entry-title">
                <span>Choose language</span>
                <span>言語を選択</span>
              </h1>
              <p className="garden-muted entry-subtitle">
                English and Japanese only.
              </p>

              <div className="entry-options" aria-label="Choose language">
                {languageOptions.map(({ language, detail }) => (
                  <button
                    key={language}
                    type="button"
                    onClick={() => onSelect(language)}
                    className="garden-button entry-choice"
                  >
                    <span className="entry-choice-copy">
                      <span>{languageLabel(language)}</span>
                      <small>{detail}</small>
                    </span>
                    <Leaf className="h-5 w-5" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>

            <footer className="sakura-footer entry-footer">
              <span aria-hidden="true" />
              <Flower2 className="h-4 w-4" aria-hidden="true" />
              <span aria-hidden="true" />
              <p>Private two-person calls</p>
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
        </div>
      </section>
    </main>
  );
}
