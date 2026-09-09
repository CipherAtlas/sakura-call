"use client";

import { Flower2, Languages, ArrowRight } from "lucide-react";
import { EntryProgress } from "@/components/EntryProgress";
import { useState } from "react";
import type { Language } from "@/lib/i18n";
import {
  isSupportedLanguage,
  supportedLanguageOptions,
  t
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
                <span>{t(selectedLanguage, "appName")}</span>
              </div>
            </header>

            <div className="entry-body">
              <h1 className="garden-title entry-title">
                <span>{t(selectedLanguage, "chooseLanguageTitle")}</span>

              </h1>
              <p className="garden-muted entry-subtitle">
                {t(selectedLanguage, "chooseLanguageHelp")}
              </p>

              <EntryProgress language={selectedLanguage} step={1} />
              <form
                className="entry-options"
                aria-label={t(selectedLanguage, "chooseLanguageTitle")}
                onSubmit={(event) => {
                  event.preventDefault();
                  onSelect(selectedLanguage);
                }}
              >
                <label className="entry-label" htmlFor="spoken-language">
                  <span>
                    <Languages className="h-4 w-4" aria-hidden="true" />
                    {t(selectedLanguage, "spokenLanguage")}
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
                    <span>{t(selectedLanguage, "continue")}</span>
                  </span>
                  <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </button>
              </form>
            </div>

            <footer className="sakura-footer entry-footer">
              <span aria-hidden="true" />
              <Flower2 className="h-4 w-4" aria-hidden="true" />
              <span aria-hidden="true" />
              <p>{t(selectedLanguage, "privateRoomCalls")}</p>
            </footer>
          </div>

          <div className="sakura-visual" aria-hidden="true" />
</div>
      </section>
    </main>
  );
}
