"use client";

import { Flower2, Languages, Leaf } from "lucide-react";
import { useState } from "react";
import type { Language } from "@/lib/i18n";
import {
  isSupportedLanguage,
  languageLabel,
  supportedLanguageOptions
} from "@/lib/i18n";

export function LanguageGate({
  onSelect
}: {
  onSelect: (language: Language) => void;
}) {
  const [selectedLanguage, setSelectedLanguage] = useState<Language>("en");

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
                Pick the language you will speak. Captions can translate it for the other person.
              </p>

              <form
                className="entry-options"
                aria-label="Choose language"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSelect(selectedLanguage);
                }}
              >
                <label className="entry-label" htmlFor="spoken-language">
                  <span>
                    <Languages className="h-4 w-4" aria-hidden="true" />
                    Spoken language
                  </span>
                  <select
                    id="spoken-language"
                    value={selectedLanguage}
                    onChange={(event) => {
                      const nextLanguage = event.target.value;

                      if (isSupportedLanguage(nextLanguage)) {
                        setSelectedLanguage(nextLanguage);
                      }
                    }}
                    className="garden-select entry-language-select"
                  >
                    {supportedLanguageOptions.map(({ code, label }) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <button type="submit" className="garden-button entry-choice">
                  <span className="entry-choice-copy">
                    <span>Continue</span>
                    <small>{languageLabel(selectedLanguage)}</small>
                  </span>
                  <Leaf className="h-5 w-5" aria-hidden="true" />
                </button>
              </form>
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
