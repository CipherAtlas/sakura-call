"use client";

import { Flower2, Leaf } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { languageLabel } from "@/lib/i18n";

export function LanguageGate({
  onSelect
}: {
  onSelect: (language: Language) => void;
}) {
  return (
    <main className="garden-scene safe-bottom grid min-h-dvh place-items-center px-6 py-8">
      <section className="garden-panel grid w-full max-w-sm gap-5 p-5">
        <div className="text-center">
          <div className="garden-bubble mx-auto grid h-14 w-14 place-items-center rounded-full">
            <Flower2 className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="garden-title mt-4 grid gap-1 text-3xl">
            <span>Choose language</span>
            <span className="text-2xl">言語を選択</span>
          </h1>
          <p className="garden-muted mt-2 text-sm font-bold">
            English / Japanese
          </p>
        </div>
        {(["en", "ja"] as const).map((language) => (
          <button
            key={language}
            type="button"
            onClick={() => onSelect(language)}
            className="garden-button garden-button-quiet h-20 justify-between px-5 text-2xl"
          >
            <span>{languageLabel(language)}</span>
            <Leaf className="garden-icon-lilac h-5 w-5" aria-hidden="true" />
          </button>
        ))}
      </section>
    </main>
  );
}
