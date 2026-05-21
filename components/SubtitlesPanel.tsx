"use client";

import { Captions, Sparkles } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export type CaptionEvent = {
  roomId: string;
  speakerId: string;
  originalLanguage: "en" | "ja";
  originalText: string;
  translatedLanguage: "en" | "ja";
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
};

export function SubtitlesPanel({
  language,
  partialCaption,
  finalCaption,
  title,
  emptyText,
  captionLog = [],
  isPreview = false,
  showOriginalText = false
}: {
  language: Language;
  partialCaption: CaptionEvent | null;
  finalCaption: CaptionEvent | null;
  title?: string;
  emptyText?: string;
  captionLog?: CaptionEvent[];
  isPreview?: boolean;
  showOriginalText?: boolean;
}) {
  const activeCaption = partialCaption ?? finalCaption;
  const shouldShowOriginalText = showOriginalText && Boolean(activeCaption?.originalText);
  const captionClassName = isPreview
    ? "subtitle-text min-h-20 text-balance text-xl font-black leading-tight tracking-normal"
    : "subtitle-text min-h-[min(38dvh,18rem)] text-balance text-2xl font-black leading-tight tracking-normal sm:text-3xl lg:text-4xl";

  return (
    <section
      className={`garden-panel subtitle-panel p-4 sm:p-5 ${
        isPreview ? "garden-preview-panel" : ""
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="garden-text-ink flex items-center gap-2 text-base font-black">
          <Captions className="garden-icon-blush h-5 w-5" aria-hidden="true" />
          {title ?? t(language, "subtitles")}
        </h2>
        {partialCaption ? (
          <span className="garden-status-partial rounded-full px-3 py-1 text-xs font-black">
            {t(language, "partial")}
          </span>
        ) : finalCaption ? (
          <span className="garden-status-final rounded-full px-3 py-1 text-xs font-black">
            {t(language, "final")}
          </span>
        ) : (
          <Sparkles className="garden-icon-blush h-5 w-5" aria-hidden="true" />
        )}
      </div>
      <p aria-live="polite" className={captionClassName}>
        {activeCaption?.translatedText ||
          emptyText ||
          t(language, "noSubtitlesYet")}
      </p>
      {shouldShowOriginalText ? (
        <div className="mt-3 rounded-lg bg-white/45 p-3 ring-1 ring-white/60">
          <p className="garden-text-muted text-xs font-black uppercase">
            {t(language, "debugOriginalTranscript")}
          </p>
          <p className="garden-text-ink mt-1 text-sm font-bold leading-snug">
            {activeCaption?.originalText}
          </p>
        </div>
      ) : null}
      {captionLog.length > 0 ? (
        <div className="subtitle-log mt-4">
          <p className="garden-text-muted mb-2 text-xs font-black uppercase">
            {t(language, "captionHistory")}
          </p>
          <div className="subtitle-log-scroll grid gap-2" tabIndex={0}>
            {captionLog.map((caption) => (
              <article
                key={`${caption.timestamp}-${caption.speakerId}`}
                className="subtitle-log-entry rounded-lg p-3"
              >
                <p className="garden-text-ink text-sm font-black leading-snug">
                  {caption.translatedText}
                </p>
                {showOriginalText ? (
                  <p className="garden-text-muted mt-1 text-xs font-bold leading-snug">
                    {caption.originalText}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
