"use client";

import { Flower2, Leaf, Video } from "lucide-react";
import type { RefObject } from "react";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export function VideoGrid({
  language,
  localVideoRef,
  remoteVideoRef,
  hasLocalVideo,
  hasRemoteVideo,
  isLocalSpeaking,
  localName,
  remoteName,
  remoteStatus
}: {
  language: Language;
  localVideoRef: RefObject<HTMLVideoElement | null>;
  remoteVideoRef: RefObject<HTMLVideoElement | null>;
  hasLocalVideo: boolean;
  hasRemoteVideo: boolean;
  isLocalSpeaking: boolean;
  localName: string;
  remoteName: string;
  remoteStatus: string;
}) {
  return (
    <section className="audio-participants grid grid-cols-1 gap-3 sm:grid-cols-2">
      <article className={`audio-card ${isLocalSpeaking ? "is-speaking" : ""}`}>
        <div
          className={`audio-avatar speaking-avatar ${
            isLocalSpeaking ? "is-speaking" : ""
          }`}
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`audio-video ${hasLocalVideo ? "opacity-100" : "opacity-0"}`}
          />
          {!hasLocalVideo ? (
            <Flower2 className="garden-icon-soft h-7 w-7" aria-hidden="true" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                isLocalSpeaking ? "speaking-dot" : "garden-neutral-dot"
              }`}
            />
            <p className="garden-text-ink truncate text-base font-black">
              {localName}
            </p>
          </div>
          <p className="garden-text-muted mt-1 text-sm font-bold">
            {hasLocalVideo ? t(language, "cameraOn") : t(language, "audioOnly")}
          </p>
        </div>
      </article>

      <article className="audio-card">
        <div className="audio-avatar">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`audio-video ${hasRemoteVideo ? "opacity-100" : "opacity-0"}`}
          />
          {!hasRemoteVideo ? (
            <Leaf className="garden-icon-soft h-7 w-7" aria-hidden="true" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Video className="garden-icon-lilac h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="garden-text-ink truncate text-base font-black">
              {remoteName}
            </p>
          </div>
          <p className="garden-text-muted mt-1 text-sm font-bold">{remoteStatus}</p>
        </div>
      </article>
    </section>
  );
}
