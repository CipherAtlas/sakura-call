"use client";

import { Captions, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
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

function formatCaptionTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function SubtitlesPanel({
  language,
  partialCaption,
  finalCaption,
  title,
  emptyText,
  captionLog = [],
  isPreview = false,
  embedded = false
}: {
  language: Language;
  partialCaption: CaptionEvent | null;
  finalCaption: CaptionEvent | null;
  title?: string;
  emptyText?: string;
  captionLog?: CaptionEvent[];
  isPreview?: boolean;
  embedded?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeCaption = partialCaption ?? finalCaption;
  const liveCaptions =
    partialCaption && !captionLog.some((caption) => caption.timestamp === partialCaption.timestamp)
      ? [...captionLog, partialCaption]
      : captionLog;

  useEffect(() => {
    const element = scrollRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [liveCaptions.length, activeCaption?.translatedText]);

  return (
    <section
      className={`subtitle-panel grid min-h-0 ${
        embedded ? "subtitle-panel-embedded" : "garden-panel p-4 sm:p-5"
      } ${
        isPreview ? "garden-preview-panel" : ""
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3 self-start">
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
      <div
        ref={scrollRef}
        aria-live="polite"
        className={`subtitle-chat-scroll grid content-end gap-2 ${
          isPreview ? "is-preview" : ""
        }`}
        tabIndex={0}
      >
        {liveCaptions.length > 0 ? (
          liveCaptions.map((caption) => {
            const isActive = activeCaption?.timestamp === caption.timestamp;

            return (
              <article
                key={`${caption.timestamp}-${caption.speakerId}`}
                className={`subtitle-chat-message rounded-lg p-3 ${
                  isActive ? "is-active" : ""
                }`}
              >
                <p
                  className="subtitle-text text-balance text-base font-black leading-tight tracking-normal sm:text-lg"
                >
                  {caption.translatedText}
                </p>
                <time
                  className="subtitle-message-time"
                  dateTime={new Date(caption.timestamp).toISOString()}
                >
                  {formatCaptionTime(caption.timestamp)}
                </time>
              </article>
            );
          })
        ) : (
          <p
            className={`garden-muted text-center text-sm font-black ${
              embedded ? "py-3" : "py-8"
            }`}
          >
            {emptyText || t(language, "noSubtitlesYet")}
          </p>
        )}
      </div>
    </section>
  );
}
