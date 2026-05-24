"use client";

import { Flower2, Leaf, Maximize2, ScreenShare } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export type MediaSurfaceId =
  | "local-video"
  | "remote-video"
  | "local-screen"
  | "remote-screen";
export type MediaSurfaceSlot = "dominant" | "small";

type ParticipantSurface = {
  hasVideo: boolean;
  id: Extract<MediaSurfaceId, "local-video" | "remote-video">;
  isAvailable: boolean;
  isSpeaking: boolean;
  kind: "participant";
  label: string;
  status: string;
  variant: "local" | "remote";
  videoRef: RefObject<HTMLVideoElement | null>;
};

type ScreenSurface = {
  id: Extract<MediaSurfaceId, "local-screen" | "remote-screen">;
  isAvailable: boolean;
  kind: "screen";
  label: string;
  videoRef: RefObject<HTMLVideoElement | null>;
};

type MediaSurface = ParticipantSurface | ScreenSurface;

function renderParticipantSurface(
  surface: ParticipantSurface,
  slot: MediaSurfaceSlot,
  {
    fullscreenLabel,
    onFullscreenSurface,
    onSelectSlot,
    selectLabel,
  }: {
    fullscreenLabel: string;
    onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
    onSelectSlot?: (slot: MediaSurfaceSlot) => void;
    selectLabel: string;
  },
) {
  const Icon = surface.variant === "local" ? Flower2 : Leaf;
  const handleSelect = () => onSelectSlot?.(slot);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect();
    }
  };

  return (
    <article
      aria-label={selectLabel}
      className={`media-surface participant-surface is-${slot} ${
        surface.hasVideo ? "has-video" : "has-no-video"
      } ${surface.isSpeaking ? "is-speaking" : ""}`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div
        className={`media-avatar speaking-avatar ${
          surface.isSpeaking ? "is-speaking" : ""
        }`}
      >
        {surface.hasVideo ? (
          <video
            ref={surface.videoRef}
            autoPlay
            muted={surface.variant === "local"}
            playsInline
            className="media-video"
          />
        ) : (
          <Icon className="garden-icon-soft h-7 w-7" aria-hidden="true" />
        )}
      </div>
      <div className="media-label">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              surface.isSpeaking ? "speaking-dot" : "garden-neutral-dot"
            }`}
          />
          <p className="truncate">{surface.label}</p>
        </div>
        {surface.status ? <span>{surface.status}</span> : null}
      </div>
      {onFullscreenSurface ? (
        <button
          type="button"
          aria-label={fullscreenLabel}
          className="media-fullscreen-button"
          onClick={(event) => {
            event.stopPropagation();
            onFullscreenSurface(surface.id);
          }}
        >
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </article>
  );
}

function renderScreenSurface(
  surface: ScreenSurface,
  slot: MediaSurfaceSlot,
  {
    fullscreenLabel,
    onFullscreenSurface,
    onSelectSlot,
    selectLabel,
  }: {
    fullscreenLabel: string;
    onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
    onSelectSlot?: (slot: MediaSurfaceSlot) => void;
    selectLabel: string;
  },
) {
  const handleSelect = () => onSelectSlot?.(slot);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect();
    }
  };

  return (
    <article
      aria-label={selectLabel}
      className={`media-surface screen-surface is-${slot}`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <video
        ref={surface.videoRef}
        autoPlay
        muted
        playsInline
        className="media-video screen-share-video"
      />
      <div className="media-label screen-share-label">
        <ScreenShare className="h-4 w-4" aria-hidden="true" />
        <span>{surface.label}</span>
      </div>
      {onFullscreenSurface ? (
        <button
          type="button"
          aria-label={fullscreenLabel}
          className="media-fullscreen-button"
          onClick={(event) => {
            event.stopPropagation();
            onFullscreenSurface(surface.id);
          }}
        >
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </article>
  );
}

function renderSurface(
  surface: MediaSurface,
  slot: MediaSurfaceSlot,
  actions: {
    fullscreenLabel: string;
    onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
    onSelectSlot?: (slot: MediaSurfaceSlot) => void;
    selectLabel: string;
  },
) {
  return surface.kind === "participant"
    ? renderParticipantSurface(surface, slot, actions)
    : renderScreenSurface(surface, slot, actions);
}

export function VideoGrid({
  language,
  localVideoRef,
  remoteVideoRef,
  localScreenRef,
  remoteScreenRef,
  hasLocalVideo,
  hasRemoteVideo,
  hasLocalScreenShare,
  hasRemoteScreenShare,
  isLocalSpeaking,
  isRemoteSpeaking,
  localName,
  dominantSurfaceId,
  smallSurfaceId,
  hasRemoteParticipant,
  onFullscreenSurface,
  onSelectSlot,
  remoteName,
  remoteStatus,
}: {
  language: Language;
  localVideoRef: RefObject<HTMLVideoElement | null>;
  remoteVideoRef: RefObject<HTMLVideoElement | null>;
  localScreenRef: RefObject<HTMLVideoElement | null>;
  remoteScreenRef: RefObject<HTMLVideoElement | null>;
  hasLocalVideo: boolean;
  hasRemoteVideo: boolean;
  hasLocalScreenShare: boolean;
  hasRemoteScreenShare: boolean;
  isLocalSpeaking: boolean;
  isRemoteSpeaking: boolean;
  localName: string;
  dominantSurfaceId: MediaSurfaceId | null;
  smallSurfaceId: MediaSurfaceId | null;
  hasRemoteParticipant: boolean;
  onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
  onSelectSlot?: (slot: MediaSurfaceSlot) => void;
  remoteName: string;
  remoteStatus: string;
}) {
  const surfaces: MediaSurface[] = [
    {
      id: "remote-screen",
      isAvailable: hasRemoteScreenShare,
      kind: "screen",
      label: t(language, "remoteScreen"),
      videoRef: remoteScreenRef,
    },
    {
      id: "local-screen",
      isAvailable: hasLocalScreenShare,
      kind: "screen",
      label: t(language, "localScreen"),
      videoRef: localScreenRef,
    },
    {
      hasVideo: hasRemoteVideo,
      id: "remote-video",
      isAvailable: hasRemoteParticipant,
      isSpeaking: isRemoteSpeaking,
      kind: "participant",
      label: remoteName,
      status: remoteStatus,
      variant: "remote",
      videoRef: remoteVideoRef,
    },
    {
      hasVideo: hasLocalVideo,
      id: "local-video",
      isAvailable: true,
      isSpeaking: isLocalSpeaking,
      kind: "participant",
      label: localName,
      status: "",
      variant: "local",
      videoRef: localVideoRef,
    },
  ];
  const availableSurfaces = surfaces.filter((surface) => surface.isAvailable);
  const dominantSurface =
    availableSurfaces.find((surface) => surface.id === dominantSurfaceId) ??
    availableSurfaces[0] ??
    null;
  const smallSurface =
    smallSurfaceId === null
      ? null
      : availableSurfaces.find(
          (surface) =>
            surface.id === smallSurfaceId && surface.id !== dominantSurface?.id,
        ) ?? null;

  if (!dominantSurface) {
    return null;
  }

  return (
    <section className={`media-layout ${smallSurface ? "has-small-surface" : ""}`}>
      <div className="media-dominant-slot">
        {renderSurface(dominantSurface, "dominant", {
          fullscreenLabel: t(language, "fullscreenSurface"),
          onFullscreenSurface,
          onSelectSlot,
          selectLabel: t(language, "openDominantPicker"),
        })}
      </div>

      {smallSurface ? (
        <div className="media-small-slot">
          {renderSurface(smallSurface, "small", {
            fullscreenLabel: t(language, "fullscreenSurface"),
            onFullscreenSurface,
            onSelectSlot,
            selectLabel: t(language, "openSmallPicker"),
          })}
        </div>
      ) : null}
    </section>
  );
}
