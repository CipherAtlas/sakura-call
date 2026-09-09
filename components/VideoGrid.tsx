"use client";

import { Flower2, Leaf, Maximize2, MicOff, VolumeX } from "lucide-react";
import { memo, type KeyboardEvent } from "react";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { ScreenShareSurface } from "./ScreenShareSurface";

export type MediaSurfaceId = string;
export type MediaLayoutMode =
  | "gallery"
  | "focus"
  | "speaker"
  | "collage"
  | "compact";
export type MediaSurfaceSlot = "dominant" | "small";
export type MediaSurfacePlacement = MediaSurfaceSlot | "tile";

export type MediaSurface = {
  hasVideo?: boolean;
  id: MediaSurfaceId;
  isLocal?: boolean;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isDeafened?: boolean;
  kind: "participant" | "screen";
  label: string;
  status?: string;
  stream: MediaStream | null;
};

function attachStreamToVideo(video: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!video) {
    return;
  }

  video.onloadedmetadata = null;
  video.oncanplay = null;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  if (stream) {
    const playVideo = () => {
      void video.play().catch(() => undefined);
    };

    video.onloadedmetadata = playVideo;
    video.oncanplay = playVideo;
    playVideo();
  }
}

function hasLiveVideoTrack(stream: MediaStream | null) {
  return (
    stream?.getVideoTracks().some((track) => track.readyState === "live") ??
    false
  );
}

function renderParticipantSurface(
  surface: MediaSurface,
  slot: MediaSurfacePlacement,
  language: Language,
  {
    fullscreenLabel,
    onFullscreenSurface,
    onSelectSurface,
    selectLabel,
  }: {
    fullscreenLabel: string;
    onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
    onSelectSurface?: (
      surfaceId: MediaSurfaceId,
      slot: MediaSurfacePlacement,
    ) => void;
    selectLabel: string;
  },
) {
  const Icon = surface.isLocal ? Flower2 : Leaf;
  const hasVideo = Boolean(surface.hasVideo || hasLiveVideoTrack(surface.stream));
  const handleSelect = () => onSelectSurface?.(surface.id, slot);
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
        hasVideo ? "has-video" : "has-no-video"
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
        {hasVideo && surface.stream ? (
          <video
            ref={(element) => attachStreamToVideo(element, surface.stream)}
            autoPlay
            muted={surface.isLocal}
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
          {surface.isMuted ? (
            <span className="media-audio-status" role="img" aria-label={t(language, "muted")} title={t(language, "muted")}>
              <MicOff aria-hidden="true" />
            </span>
          ) : null}
          {surface.isDeafened ? (
            <span className="media-audio-status" role="img" aria-label={t(language, "deafened")} title={t(language, "deafened")}>
              <VolumeX aria-hidden="true" />
            </span>
          ) : null}
        </div>
        {surface.status && !surface.isMuted && !surface.isDeafened ? <span>{surface.status}</span> : null}
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
  slot: MediaSurfacePlacement,
  actions: {
    language: Language;
    fullscreenLabel: string;
    onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
    onSelectSurface?: (
      surfaceId: MediaSurfaceId,
      slot: MediaSurfacePlacement,
    ) => void;
    selectLabel: string;
  },
) {
  return surface.kind === "screen"
    ? <ScreenShareSurface key={surface.id} surface={surface} slot={slot} {...actions} />
    : renderParticipantSurface(surface, slot, actions.language, actions);
}

function VideoGridComponent({
  dominantSurfaceId,
  layoutMode,
  language,
  onFullscreenSurface,
  onSelectSurface,
  surfaces,
}: {
  dominantSurfaceId: MediaSurfaceId | null;
  layoutMode: MediaLayoutMode;
  language: Language;
  onFullscreenSurface?: (surfaceId: MediaSurfaceId) => void;
  onSelectSurface?: (
    surfaceId: MediaSurfaceId,
    slot: MediaSurfacePlacement,
  ) => void;
  surfaces: MediaSurface[];
}) {
  const availableSurfaces = surfaces.filter((surface) => surface.stream || surface.kind === "participant");
  const screenSurface = availableSurfaces.find((surface) => surface.kind === "screen");
  const participantSurfaces = availableSurfaces.filter(
    (surface) => surface.kind === "participant",
  );
  const participantDensityClass =
    participantSurfaces.length > 1
      ? "has-multiple-participants"
      : "is-single-participant";
  const selectedSurface = availableSurfaces.find(
    (surface) => surface.id === dominantSurfaceId,
  );
  const selectedParticipant =
    selectedSurface?.kind === "participant" ? selectedSurface : null;
  const speakingSurface = participantSurfaces.find((surface) => surface.isSpeaking);
  const effectiveLayoutMode =
    participantSurfaces.length > 1 ? layoutMode : "gallery";
  const preferredParticipant =
    effectiveLayoutMode === "speaker"
      ? speakingSurface ?? selectedParticipant ?? participantSurfaces[0] ?? null
      : selectedParticipant ?? speakingSurface ?? participantSurfaces[0] ?? null;

  if (!screenSurface && participantSurfaces.length === 0) {
    return null;
  }

  if (screenSurface) {
    const dominantSharedSurface = selectedSurface ?? screenSurface;
    const stripSurfaces = availableSurfaces.filter(
      (surface) => surface.id !== dominantSharedSurface.id,
    );

    return (
      <section
        className={`media-layout media-layout-group has-screen-share ${participantDensityClass}`}
      >
        <div className="media-dominant-slot">
          {renderSurface(dominantSharedSurface, "dominant", {
            language,
            fullscreenLabel: t(language, "fullscreenSurface"),
            onFullscreenSurface,
            onSelectSurface,
            selectLabel: t(language, "openDominantPicker"),
          })}
        </div>
        {stripSurfaces.length > 0 ? (
          <div className="media-gallery-strip" aria-label={t(language, "participants")}>
            {stripSurfaces.map((surface) => (
              <div className="media-gallery-tile" key={surface.id}>
                {renderSurface(surface, "tile", {
                  language,
                  fullscreenLabel: t(language, "fullscreenSurface"),
                  onFullscreenSurface,
                  onSelectSurface,
                  selectLabel: t(language, "openDominantPicker"),
                })}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  if (
    (effectiveLayoutMode === "focus" || effectiveLayoutMode === "speaker") &&
    preferredParticipant
  ) {
    const stripSurfaces = participantSurfaces.filter(
      (surface) => surface.id !== preferredParticipant.id,
    );

    return (
      <section
        className={`media-layout media-layout-group has-focus media-layout-${effectiveLayoutMode} ${participantDensityClass} ${stripSurfaces.length === 1 ? "has-participant-inset" : ""}`}
      >
        <div className="media-dominant-slot">
          {renderSurface(preferredParticipant, "dominant", {
            language,
            fullscreenLabel: t(language, "fullscreenSurface"),
            onFullscreenSurface,
            onSelectSurface,
            selectLabel: t(language, "openDominantPicker"),
          })}
        </div>
        {stripSurfaces.length > 0 ? (
          <div className="media-gallery-strip" aria-label={t(language, "participants")}>
            {stripSurfaces.map((surface) => (
              <div className="media-gallery-tile" key={surface.id}>
                {renderSurface(surface, "tile", {
                  language,
                  fullscreenLabel: t(language, "fullscreenSurface"),
                  onFullscreenSurface,
                  onSelectSurface,
                  selectLabel: t(language, "openDominantPicker"),
                })}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={`media-layout media-layout-group is-gallery-only media-layout-${effectiveLayoutMode} ${participantDensityClass}`}
    >
      <div className="media-gallery-grid" aria-label={t(language, "participants")}>
        {participantSurfaces.map((surface) => (
          <div
            className={`media-gallery-tile ${
              effectiveLayoutMode === "collage" && surface.id === preferredParticipant?.id
                ? "is-featured"
                : ""
            }`}
            key={surface.id}
          >
            {renderSurface(surface, "tile", {
              language,
              fullscreenLabel: t(language, "fullscreenSurface"),
              onFullscreenSurface,
              onSelectSurface,
              selectLabel: t(language, "openDominantPicker"),
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

export const VideoGrid = memo(VideoGridComponent);
