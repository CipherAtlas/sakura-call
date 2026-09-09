"use client";

import { Captions, MessageSquare, Mic, Send, LoaderCircle, Paperclip, File, Download, X } from "lucide-react";
import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from "react";
import { chatTextLimit, type ChatMessage } from "@/lib/chat";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export type CaptionEvent = {
  roomId: string;
  speakerId: string;
  originalLanguage: Language;
  originalText: string;
  translatedLanguage: Language;
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
};

type ConversationCaption = CaptionEvent & {
  isLocal: boolean;
  speakerName: string;
  attachment?: ChatMessage["attachment"];
  id?: string;
  translationStatus?: ChatMessage["translationStatus"];
};

function formatFileSize(size: number) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
}

function formatCaptionTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
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

type ConversationPanelProps = {
  controls?: ReactNode;
  attachmentDraft: ChatMessage["attachment"] | null;
  onAttach: (file: globalThis.File) => void;
  onRemoveAttachment: () => void;
  fileError: boolean;
  downloads: Record<string, number | "failed">;
  onDownload: (message: ChatMessage) => void;
  availableFileSenders: string[];
  chatMessages: ChatMessage[];
  localParticipantId: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  isSending: boolean;
  sendError: boolean;
  language: Language;
  localCaptionLog?: CaptionEvent[];
  localName: string;
  localPartialCaption: CaptionEvent | null;
  remoteCaptionLog?: CaptionEvent[];
  remoteName: string;
  remotePartialCaption: CaptionEvent | null;
  speakerNames?: Record<string, string>;
};

export const ConversationPanel = memo(function ConversationPanel({
  controls,
  attachmentDraft, onAttach, onRemoveAttachment, fileError, downloads, onDownload, availableFileSenders,
  chatMessages, localParticipantId, draft, onDraftChange, onSend, isSending, sendError,
  language,
  localCaptionLog = [],
  localName,
  localPartialCaption,
  remoteCaptionLog = [],
  remoteName,
  remotePartialCaption,
  speakerNames = {},
}: ConversationPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
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
      speakerName: speakerNames[caption.speakerId] ?? remoteName,
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
      remotePartialCaption
        ? speakerNames[remotePartialCaption.speakerId] ?? remoteName
        : remoteName,
    );

    const typedMessages: ConversationCaption[] = chatMessages.map(message => ({
      ...message, isFinal: true, isLocal: message.speakerId === localParticipantId,
    }));
    return [...withRemoteLive, ...typedMessages].sort((first, second) => {
      if (first.timestamp === second.timestamp) {
        return first.isLocal === second.isLocal ? 0 : first.isLocal ? 1 : -1;
      }

      return first.timestamp - second.timestamp;
    });
  }, [
    chatMessages, localParticipantId,
    localCaptionLog,
    localName,
    localPartialCaption,
    remoteCaptionLog,
    remoteName,
    remotePartialCaption,
    speakerNames,
  ]);

  useEffect(() => {
    const input = composerRef.current;
    if (input) {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }
  }, [draft]);

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
  }, [messages, activeCaption?.translatedText]);

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

      {controls}
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
              const hasTranslation =
                caption.originalLanguage !== language &&
                caption.translatedLanguage === language &&
                Boolean(caption.translatedText.trim()) &&
                caption.translatedText.trim() !== caption.originalText.trim();
              const isActive =
                activeCaption?.timestamp === caption.timestamp &&
                activeCaption.speakerId === caption.speakerId;

              return (
                <article
                  key={caption.id ?? `${caption.isLocal ? "local" : "remote"}-${caption.timestamp}-${caption.speakerId}`}
                  className={`conversation-message ${
                    caption.isLocal ? "is-local" : "is-remote"
                  } ${isActive ? "is-active" : ""}`}
                >
                  <div className="conversation-meta">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {caption.id ? <MessageSquare className="h-3 w-3 shrink-0" aria-label={t(language, "typedMessage")} /> : <Mic className="h-3 w-3 shrink-0" aria-label={t(language, "spokenMessage")} />}
                      <span className="truncate">{caption.speakerName}</span>
                    </span>
                    <time dateTime={new Date(caption.timestamp).toISOString()}>
                      {formatCaptionTime(caption.timestamp)}
                    </time>
                  </div>
                  {caption.originalText ? <p className="conversation-primary" lang={hasTranslation ? caption.translatedLanguage : caption.originalLanguage}>
                    {hasTranslation ? caption.translatedText : caption.originalText}
                  </p> : null}
                  {hasTranslation ? <p className="conversation-source" lang={caption.originalLanguage}>
                    {caption.originalText}
                  </p> : null}
                  {caption.attachment ? (() => {
                    const progress = caption.id ? downloads[caption.id] : undefined;
                    const available = availableFileSenders.includes(caption.speakerId);
                    return <div className="conversation-file">
                      <File aria-hidden="true" />
                      <span className="conversation-file-details"><span>{caption.attachment.name}</span><small>{formatFileSize(caption.attachment.size)}</small></span>
                      {typeof progress === "number" ? <span className="file-download-progress" role="progressbar" aria-label={t(language, "fileDownloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                        <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="progress-track" cx="22" cy="22" r="19" /><circle className="progress-value" cx="22" cy="22" r="19" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progress} /></svg>
                        <span>{progress}%</span>
                      </span> : !caption.isLocal ? <button type="button" className="conversation-file-download" disabled={!available}
                        aria-label={`${t(language, progress === "failed" ? "fileRetry" : available ? "fileDownload" : "fileUnavailable")}: ${caption.attachment.name}`}
                        onClick={() => { const message = chatMessages.find(item => item.id === caption.id); if (message) onDownload(message); }}>
                        <Download aria-hidden="true" /><span>{t(language, progress === "failed" ? "fileRetry" : available ? "fileDownload" : "fileUnavailable")}</span>
                      </button> : null}
                    </div>;
                  })() : null}
                  {caption.translationStatus === "pending" || caption.translationStatus === "unavailable" ? (
                    <p className="conversation-translation-status">{t(language, caption.translationStatus === "pending" ? "chatTranslating" : "chatTranslationUnavailable")}</p>
                  ) : null}
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
      <form className="conversation-composer-wrap" onSubmit={event => { event.preventDefault(); if ((draft.trim() || attachmentDraft) && !isSending) onSend(); }}>
        {attachmentDraft ? <div className="conversation-attachment-draft"><File aria-hidden="true" /><span>{attachmentDraft.name}</span><button type="button" onClick={onRemoveAttachment} disabled={isSending} aria-label={t(language, "fileRemove")}><X aria-hidden="true" /></button></div> : null}
        <input type="file" ref={fileInputRef} hidden onChange={event => {
          const file = event.target.files?.[0];
          if (file) onAttach(file);
          event.target.value = "";
        }} />
        <div className="conversation-composer">
          <button type="button" className="conversation-attach" disabled={isSending} aria-label={t(language, "fileAttach")} onClick={() => fileInputRef.current?.click()}><Paperclip aria-hidden="true" /></button>
          <textarea ref={composerRef} rows={1} maxLength={chatTextLimit}
            aria-label={t(language, "chatPlaceholder")} placeholder={t(language, "chatPlaceholder")}
            value={draft} onChange={event => onDraftChange(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) {
                event.preventDefault();
                if ((draft.trim() || attachmentDraft) && !isSending) onSend();
              }
            }} />
          <button type="submit" className="garden-button garden-button-primary conversation-send" disabled={(!draft.trim() && !attachmentDraft) || isSending}
            aria-label={t(language, isSending ? "chatSending" : "chatSend")}>
            {isSending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          </button>
        </div>
        {fileError ? <p role="alert" className="conversation-send-error">{t(language, "fileTooLarge")}</p> : null}
        {sendError ? <p role="alert" className="conversation-send-error">{t(language, "chatSendFailed")}</p> : null}
      </form>
    </section>
  );
});
