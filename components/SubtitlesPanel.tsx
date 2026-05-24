"use client";

import { Captions, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

type ConversationCaption = CaptionEvent & {
  isLocal: boolean;
  speakerName: string;
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

function appendLiveCaption(
  captions: ConversationCaption[],
  caption: CaptionEvent | null,
  isLocal: boolean,
  speakerName: string,
) {
  if (
    !caption ||
    captions.some(
      (item) =>
        item.timestamp === caption.timestamp &&
        item.speakerId === caption.speakerId,
    )
  ) {
    return captions;
  }

  return [
    ...captions,
    {
      ...caption,
      isLocal,
      speakerName,
    },
  ];
}

function captionLanguageLabel(language: CaptionEvent["originalLanguage"]) {
  return language === "en" ? "English" : "日本語";
}

export function ConversationPanel({
  language,
  localCaptionLog = [],
  localFinalCaption,
  localName,
  localPartialCaption,
  remoteCaptionLog = [],
  remoteFinalCaption,
  remoteName,
  remotePartialCaption,
}: {
  language: Language;
  localCaptionLog?: CaptionEvent[];
  localFinalCaption: CaptionEvent | null;
  localName: string;
  localPartialCaption: CaptionEvent | null;
  remoteCaptionLog?: CaptionEvent[];
  remoteFinalCaption: CaptionEvent | null;
  remoteName: string;
  remotePartialCaption: CaptionEvent | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [hasUnread, setHasUnread] = useState(false);
  const activeCaption = remotePartialCaption ?? localPartialCaption;
  const messages = useMemo(() => {
    const localMessages = localCaptionLog.map((caption) => ({
      ...caption,
      isLocal: true,
      speakerName: localName,
    }));
    const remoteMessages = remoteCaptionLog.map((caption) => ({
      ...caption,
      isLocal: false,
      speakerName: remoteName,
    }));
    const withLocalLive = appendLiveCaption(
      [...localMessages, ...remoteMessages],
      localPartialCaption,
      true,
      localName,
    );
    const withRemoteLive = appendLiveCaption(
      withLocalLive,
      remotePartialCaption,
      false,
      remoteName,
    );

    return withRemoteLive.sort((first, second) => {
      if (first.timestamp === second.timestamp) {
        return first.isLocal === second.isLocal ? 0 : first.isLocal ? 1 : -1;
      }

      return first.timestamp - second.timestamp;
    });
  }, [
    localCaptionLog,
    localName,
    localPartialCaption,
    remoteCaptionLog,
    remoteName,
    remotePartialCaption,
  ]);

  useEffect(() => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    if (shouldAutoScrollRef.current) {
      element.scrollTop = element.scrollHeight;
      setHasUnread(false);
      return;
    }

    setHasUnread(true);
  }, [messages.length, activeCaption?.translatedText]);

  const handleScrollToLatest = () => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    shouldAutoScrollRef.current = true;
    element.scrollTop = element.scrollHeight;
    setHasUnread(false);
  };

  const handleScroll = () => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 96;

    if (shouldAutoScrollRef.current) {
      setHasUnread(false);
    }
  };

  const hasLiveCaption = Boolean(remotePartialCaption || localPartialCaption);
  const conversationStatus = hasLiveCaption ? (
    <span className="garden-status-partial rounded-full px-3 py-1 text-xs font-black">
      {t(language, "partial")}
    </span>
  ) : remoteFinalCaption || localFinalCaption ? (
    <span className="garden-status-final rounded-full px-3 py-1 text-xs font-black">
      {t(language, "final")}
    </span>
  ) : null;

  return (
    <section className="conversation-panel garden-panel grid min-h-0 p-3 sm:p-4">
      <div className="conversation-header mb-2 flex items-center justify-between gap-3 self-start">
        <h2 className="garden-text-ink flex min-w-0 items-center gap-2 text-base font-black">
          <Captions className="garden-icon-blush h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t(language, "conversation")}</span>
        </h2>
        {conversationStatus ? (
          <div className="conversation-header-actions">{conversationStatus}</div>
        ) : null}
      </div>

      <div className="conversation-scroll-wrap min-h-0">
        <div
          ref={scrollRef}
          aria-live="polite"
          className="conversation-scroll"
          onScroll={handleScroll}
          tabIndex={0}
        >
          {messages.length > 0 ? (
            messages.map((caption) => {
              const isActive =
                activeCaption?.timestamp === caption.timestamp &&
                activeCaption.speakerId === caption.speakerId;

              return (
                <article
                  key={`${caption.isLocal ? "local" : "remote"}-${caption.timestamp}-${caption.speakerId}`}
                  className={`conversation-message ${
                    caption.isLocal ? "is-local" : "is-remote"
                  } ${isActive ? "is-active" : ""}`}
                >
                  <div className="conversation-meta">
                    <span className="truncate">{caption.speakerName}</span>
                    <time dateTime={new Date(caption.timestamp).toISOString()}>
                      {formatCaptionTime(caption.timestamp)}
                    </time>
                  </div>
                  <p className="conversation-original">
                    {caption.originalText}
                  </p>
                  <p className="conversation-translation">
                    <span>
                      {captionLanguageLabel(caption.translatedLanguage)}
                    </span>
                    {caption.translatedText}
                  </p>
                </article>
              );
            })
          ) : (
            <p className="garden-muted px-4 py-8 text-center text-sm font-black">
              {t(language, "noConversationYet")}
            </p>
          )}
        </div>

        {hasUnread ? (
          <button
            type="button"
            onClick={handleScrollToLatest}
            className="conversation-latest-button garden-button garden-button-primary px-3 py-2 text-xs"
          >
            {t(language, "latestMessages")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
