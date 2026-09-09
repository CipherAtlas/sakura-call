"use client";

import type { ScreenShareStatsSnapshot } from "@/lib/screenShareStreaming";

import {
  screenSharePresetDefaults,
  type ScreenSharePresetId,
  type ScreenShareQualitySettings,
} from "@/lib/screenShareQuality";

import {
  Camera,
  Check,
  Mic,
  MicOff,
  Monitor,
  Moon,
  PhoneOff,
  ScreenShare,
  SlidersHorizontal,
  Sun,
  TowerControl,
  Volume2,
  X,
} from "lucide-react";
import { memo, type CSSProperties, type ReactNode } from "react";
import { microphoneChannelModes } from "@/lib/audioEnhancement";
import type {
  MicrophoneChannelMode,
  MicrophoneLevelSnapshot,
  MicrophoneProcessingSettings,
} from "@/lib/audioEnhancement";
import {
  isSupportedLanguage,
  supportedLanguageOptions,
  t,
} from "@/lib/i18n";
import type { Language, TranslationKey } from "@/lib/i18n";
import type { ThemeMode } from "@/lib/theme";
import type {
  MediaLayoutMode,
  MediaSurface,
  MediaSurfaceId,
  MediaSurfacePlacement,
} from "@/components/VideoGrid";

type CallState =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "disconnected";

type TurnPhase = "disabled" | "ready" | "error";

type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  provider?: string;
  host?: string;
  expiresAt?: number;
  updatedAt: number;
};

type ScreenShareConnectionPath = "direct" | "relay" | "unknown";
type ConnectionPathSummary = ScreenShareConnectionPath | "mixed";

type PeerConnectionPathSnapshot = {
  displayName: string;
  participantId: string;
  path: ScreenShareConnectionPath;
  roundTripMs?: number;
  updatedAt: number;
};



type RemoteAudioParticipant = {
  displayName: string;
  participantId: string;
};

type SurfacePickerTarget = {
  scope: "call" | "fullscreen";
  slot: MediaSurfacePlacement;
  surfaceId: MediaSurfaceId;
};

export const mediaLayoutModes: MediaLayoutMode[] = [
  "gallery",
  "focus",
  "speaker",
  "collage",
  "compact",
];

export const screenShareResolutionOptions = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "4K", width: 3840, height: 2160 },
] as const;

const mediaLayoutModeTranslationKeys: Record<MediaLayoutMode, TranslationKey> = {
  gallery: "layoutGallery",
  focus: "layoutFocus",
  speaker: "layoutSpeaker",
  collage: "layoutCollage",
  compact: "layoutCompact",
};

const screenSharePresetIds: ScreenSharePresetId[] = [
  "detail",
  "balanced",
  "motion",
  "ultra",
  "custom",
];

function clampUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function unitPercent(value: number) {
  return Math.round(clampUnit(value) * 100);
}

function unitPercentStyle(value: number) {
  return `${(clampUnit(value) * 100).toFixed(1)}%`;
}

function turnStatusLabel(language: Language, status: TurnStatus | null) {
  switch (status?.phase) {
    case "disabled":
      return t(language, "turnRelayNotConfigured");
    case "ready":
      return t(language, "turnRelayReady");
    case "error":
      return t(language, "turnRelayError");
    default:
      return t(language, "turnRelayOff");
  }
}

function connectionPathLabel(language: Language, path: ConnectionPathSummary) {
  switch (path) {
    case "direct":
      return t(language, "connectionPathDirect");
    case "relay":
      return t(language, "connectionPathRelay");
    case "mixed":
      return t(language, "connectionPathMixed");
    case "unknown":
      return t(language, "connectionPathUnknown");
  }
}

function screenSharePresetLabel(language: Language, presetId: ScreenSharePresetId) {
  switch (presetId) {
    case "detail":
      return t(language, "screenQualityDetail");
    case "balanced":
      return t(language, "screenQualityBalanced");
    case "motion":
      return t(language, "screenQualityMotion");
    case "ultra":
      return t(language, "screenQualityUltra");
    case "custom":
      return t(language, "screenQualityCustom");
  }
}

function screenSharePresetHelp(language: Language, presetId: ScreenSharePresetId, current: ScreenShareQualitySettings) {
  const settings = presetId === "custom" ? current : screenSharePresetDefaults[presetId];
  const number = new Intl.NumberFormat(language);
  const resolution = presetId === "custom" ? `${settings.width} × ${settings.height}` : `${settings.height}p`;
  return `${resolution} · ${number.format(settings.frameRate)} fps · ${number.format(settings.bitrateKbps / 1000)} Mbps`;
}

function microphoneChannelModeLabel(
  language: Language,
  mode: MicrophoneChannelMode,
) {
  switch (mode) {
    case "auto":
      return t(language, "microphoneChannelAuto");
    case "input1":
      return t(language, "microphoneChannelInput1");
    case "input2":
      return t(language, "microphoneChannelInput2");
    case "mix":
      return t(language, "microphoneChannelMix");
  }
}

function ModalBackdrop({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="settings-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
      onClick={onClose}
    >
      {children}
    </div>
  );
}

function SurfacePickerModal({
  language,
  onClose,
  onSelectSurface,
  open,
  orderedSurfaces,
  selectedSurfaceId,
  titleKey,
}: {
  language: Language;
  onClose: () => void;
  onSelectSurface: (surfaceId: MediaSurfaceId) => void;
  open: boolean;
  orderedSurfaces: MediaSurface[];
  selectedSurfaceId: MediaSurfaceId | null;
  titleKey: TranslationKey;
}) {
  if (!open) {
    return null;
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section
        aria-labelledby="surface-picker-modal-title"
        aria-modal="true"
        className="settings-modal surface-picker-modal max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-hidden"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-ribbon" aria-hidden="true" />
        <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">

            <h2
              className="garden-title mt-2 text-2xl"
              id="surface-picker-modal-title"
            >
              {t(language, titleKey)}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeLayoutPicker")}
            onClick={onClose}
            className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="surface-picker-options grid gap-3 px-5 pb-5">
          {orderedSurfaces.map((surface) => {
            const Icon = surface.kind === "screen" ? ScreenShare : Camera;
            const isCurrentSurface = surface.id === selectedSurfaceId;
            const surfaceStatus =
              surface.status ||
              t(
                language,
                surface.kind === "screen" ? "shareControl" : "cameraControl",
              );

            return (
              <button
                key={surface.id}
                type="button"
                onClick={() => onSelectSurface(surface.id)}
                className={`view-layout-option surface-picker-option ${
                  isCurrentSurface ? "is-selected" : ""
                }`}
              >
                <span
                  className={`surface-picker-preview is-${surface.kind}`}
                  aria-hidden="true"
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="view-layout-option-copy surface-picker-option-copy">
                  <span>{surface.label}</span>
                  <small>
                    {isCurrentSurface ? t(language, "selected") : surfaceStatus}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </ModalBackdrop>
  );
}

function LeaveConfirmationModal({
  isRoomHost,  language,
  onClose,
  onLeave,
  open,
}: {
  isRoomHost: boolean;
  language: Language;
  onClose: () => void;
  onLeave: () => void;
  open: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section
        aria-describedby="leave-confirmation-modal-body"
        aria-labelledby="leave-confirmation-modal-title"
        aria-modal="true"
        className="settings-modal max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-hidden"
        id="leave-confirmation-modal"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-ribbon" aria-hidden="true" />
        <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">

            <h2
              className="garden-title mt-2 text-2xl"
              id="leave-confirmation-modal-title"
            >
              {t(language, isRoomHost ? "endCallTitle" : "leaveConfirmationTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeLeaveConfirmation")}
            onClick={onClose}
            className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-modal-content grid gap-4 px-5 pb-5">
          <section className="settings-modal-section">
            <p
              className="garden-muted text-base font-bold leading-snug"
              id="leave-confirmation-modal-body"
            >
              {t(language, isRoomHost ? "endCallBody" : "leaveConfirmationBody")}
            </p>
          </section>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              autoFocus
              onClick={onClose}
              className="garden-button garden-button-quiet h-12 px-5"
            >
              {t(language, "stayInCall")}
            </button>
            <button
              type="button"
              onClick={onLeave}
              className="garden-button garden-button-danger h-12 px-5"
            >
              <PhoneOff className="h-5 w-5" aria-hidden="true" />
              <span>{t(language, isRoomHost ? "endCallAction" : "leaveControl")}</span>
            </button>
          </div>
        </div>
      </section>
    </ModalBackdrop>
  );
}

function LayoutPickerModal({
  language,
  mediaLayoutMode,
  onChange,
  onClose,
  open,
}: {
  language: Language;
  mediaLayoutMode: MediaLayoutMode;
  onChange: (mode: MediaLayoutMode) => void;
  onClose: () => void;
  open: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section
        aria-labelledby="view-layout-modal-title"
        aria-modal="true"
        className="settings-modal view-layout-modal max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-hidden"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-ribbon" aria-hidden="true" />
        <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">

            <h2
              className="garden-title mt-2 text-2xl"
              id="view-layout-modal-title"
            >
              {t(language, "viewLayout")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeSettings")}
            onClick={onClose}
            className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="view-layout-options grid gap-3 px-5 pb-5">
          {mediaLayoutModes.map((mode) => {
            const isSelected = mode === mediaLayoutMode;

            return (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(mode)}
                className={`view-layout-option ${
                  isSelected ? "is-selected" : ""
                }`}
              >
                <span className={`view-layout-preview is-${mode}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="view-layout-option-copy">
                  <span>{t(language, mediaLayoutModeTranslationKeys[mode])}</span>
                  {isSelected ? <small>{t(language, "selected")}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </ModalBackdrop>
  );
}

function ThemePanel({
  language,
  onThemeChange,
  theme,
}: {
  language: Language;
  onThemeChange: (theme: ThemeMode) => void;
  theme: ThemeMode;
}) {
  return (
    <section className="settings-modal-section theme-settings-panel">
      <p className="garden-text-muted text-sm font-black">
        {t(language, "theme")}
      </p>
      <div className="theme-mode-toggle" role="group" aria-label={t(language, "theme")}>
        {(["system", "light", "dark"] as const).map((mode) => {
          const Icon =
            mode === "system" ? Monitor : mode === "dark" ? Moon : Sun;

          return (
            <button
              key={mode}
              type="button"
              aria-pressed={theme === mode}
              onClick={() => onThemeChange(mode)}
              className={`theme-mode-button ${theme === mode ? "is-selected" : ""}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>
                {mode === "system"
                  ? t(language, "themeSystem")
                  : mode === "dark"
                    ? t(language, "themeDark")
                    : t(language, "themeLight")}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function RemoteAudioPanel({
  language,
  localInputVolume,
  masterOutputVolume,
  onLocalInputVolumeChange,
  onMasterOutputVolumeChange,
  onRemoteVolumeChange,
  onScreenShareAudioVolumeChange,
  remoteParticipants,
  remoteVolumes,
  screenShareAudioVolume,
}: {
  language: Language;
  localInputVolume: number;
  masterOutputVolume: number;
  onLocalInputVolumeChange: (value: string) => void;
  onMasterOutputVolumeChange: (value: string) => void;
  onRemoteVolumeChange: (participantId: string, value: string) => void;
  onScreenShareAudioVolumeChange: (value: string) => void;
  remoteParticipants: RemoteAudioParticipant[];
  remoteVolumes: Record<string, number>;
  screenShareAudioVolume: number;
}) {
  return (
    <section className="settings-modal-section participant-volume-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <Volume2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="garden-text-ink text-base font-black">
            {t(language, "audioMixerTitle")}
          </h2>
          <div className="participant-volume-list">
            <label className="participant-volume-row">
              <span className="participant-volume-name">
                {t(language, "mixerMicInput")}
              </span>
              <input
                aria-label={t(language, "mixerMicInputVolume")}
                max="100"
                min="0"
                onChange={(event) => onLocalInputVolumeChange(event.target.value)}
                step="1"
                type="range"
                value={Math.round(localInputVolume * 100)}
              />
              <span className="participant-volume-value">
                {Math.round(localInputVolume * 100)}%
              </span>
            </label>
            <label className="participant-volume-row">
              <span className="participant-volume-name">
                {t(language, "mixerMasterOutput")}
              </span>
              <input
                aria-label={t(language, "mixerMasterOutputVolume")}
                max="100"
                min="0"
                onChange={(event) => onMasterOutputVolumeChange(event.target.value)}
                step="1"
                type="range"
                value={Math.round(masterOutputVolume * 100)}
              />
              <span className="participant-volume-value">
                {Math.round(masterOutputVolume * 100)}%
              </span>
            </label>
            <label className="participant-volume-row">
              <span className="participant-volume-name">
                {t(language, "mixerScreenShareAudio")}
              </span>
              <input
                aria-label={t(language, "mixerScreenShareAudioVolume")}
                max="100"
                min="0"
                onChange={(event) =>
                  onScreenShareAudioVolumeChange(event.target.value)
                }
                step="1"
                type="range"
                value={Math.round(screenShareAudioVolume * 100)}
              />
              <span className="participant-volume-value">
                {Math.round(screenShareAudioVolume * 100)}%
              </span>
            </label>
            {remoteParticipants.map((participant) => {
              const volume = Math.round(
                (remoteVolumes[participant.participantId] ?? 1) * 100,
              );

              return (
                <label
                  className="participant-volume-row"
                  key={participant.participantId}
                >
                  <span className="participant-volume-name">
                    {participant.displayName}
                  </span>
                  <input
                    aria-label={`${participant.displayName} ${t(
                      language,
                      "volume",
                    )}`}
                    max="100"
                    min="0"
                    onChange={(event) =>
                      onRemoteVolumeChange(
                        participant.participantId,
                        event.target.value,
                      )
                    }
                    step="1"
                    type="range"
                    value={volume}
                  />
                  <span className="participant-volume-value">{volume}%</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConnectionPathPanel({
  connectionPathRows,
  connectionPathSummary,
  language,
}: {
  connectionPathRows: PeerConnectionPathSnapshot[];
  connectionPathSummary: ConnectionPathSummary;
  language: Language;
}) {
  return (
    <section className="settings-modal-section connection-path-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <TowerControl className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="garden-text-ink text-base font-black">
              {t(language, "connectionPathTitle")}
            </h2>
            <span className={`connection-path-pill is-${connectionPathSummary}`}>
              {connectionPathLabel(language, connectionPathSummary)}
            </span>
          </div>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {t(language, "connectionPathHelp")}
          </p>

          <div className="connection-path-list">
            {connectionPathRows.length > 0 ? (
              connectionPathRows.map((snapshot) => (
                <div
                  className="connection-path-row"
                  key={snapshot.participantId}
                >
                  <span className="connection-path-peer">
                    {snapshot.displayName}
                  </span>
                  <span className={`connection-path-pill is-${snapshot.path}`}>
                    {connectionPathLabel(language, snapshot.path)}
                  </span>
                  {snapshot.roundTripMs !== undefined ? (
                    <span className="connection-path-rtt">
                      {t(language, "connectionPathRoundTrip")}{" "}
                      {snapshot.roundTripMs} ms
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="connection-path-empty">
                {t(language, "connectionPathNoPeers")}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function TurnRelayPanel({
  language,
  turnRelayReady,
  turnStatus,
}: {
  language: Language;
  turnRelayReady: boolean;
  turnStatus: TurnStatus | null;
}) {
  return (
    <section className="settings-modal-section turn-relay-panel">
      <div className="flex items-start gap-3">
        <div className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
          <TowerControl className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="garden-text-ink text-base font-black">
              {t(language, "turnRelayTitle")}
            </h2>
            <span
              className={`turn-relay-pill ${
                turnRelayReady ? "is-ready" : turnStatus?.phase === "error" ? "is-error" : ""
              }`}
            >
              {turnStatusLabel(language, turnStatus)}
            </span>
          </div>
          <p className="garden-muted mt-1 text-sm font-bold leading-snug">
            {turnRelayReady
              ? t(language, "turnRelayReadyHelp")
              : t(language, "turnRelayHelp")}
          </p>
          {turnStatus?.provider ? (
            <p className="garden-muted mt-2 truncate text-xs font-black">
              {turnStatus.provider}
            </p>
          ) : null}
          {turnStatus?.host ? (
            <p className="garden-muted mt-1 truncate text-xs font-black">
              {turnStatus.host}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CallSettingsModal({
  callState,
  canManageTurnRelay,
  connectionPathRows,
  connectionPathSummary,
  language,
  localInputVolume,
  masterOutputVolume,
  onClose,
  onLanguageSelect,
  onLocalInputVolumeChange,
  onMasterOutputVolumeChange,
  onOpenVoiceSettings,
  onRemoteVolumeChange,
  onScreenShareAudioVolumeChange,
  onThemeChange,
  open,
  remoteParticipants,
  remoteVolumes,
  screenShareAudioVolume,
  theme,
  turnRelayReady,
  turnStatus,
}: {
  callState: CallState;
  canManageTurnRelay: boolean;
  connectionPathRows: PeerConnectionPathSnapshot[];
  connectionPathSummary: ConnectionPathSummary;
  language: Language;
  localInputVolume: number;
  masterOutputVolume: number;
  onClose: () => void;
  onLanguageSelect: (language: Language) => void;
  onLocalInputVolumeChange: (value: string) => void;
  onMasterOutputVolumeChange: (value: string) => void;
  onOpenVoiceSettings: () => void;
  onRemoteVolumeChange: (participantId: string, value: string) => void;
  onScreenShareAudioVolumeChange: (value: string) => void;
  onThemeChange: (theme: ThemeMode) => void;
  open: boolean;
  remoteParticipants: RemoteAudioParticipant[];
  remoteVolumes: Record<string, number>;
  screenShareAudioVolume: number;
  theme: ThemeMode;
  turnRelayReady: boolean;
  turnStatus: TurnStatus | null;
}) {
  if (!open) {
    return null;
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section
        aria-labelledby="call-settings-modal-title"
        aria-modal="true"
        className="settings-modal max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-hidden"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-ribbon" aria-hidden="true" />
        <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">

            <h2
              className="garden-title mt-2 text-2xl"
              id="call-settings-modal-title"
            >
              {t(language, "settings")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeSettings")}
            onClick={onClose}
            className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-modal-content grid gap-4 px-5 pb-5">
          <section className="settings-modal-section">
            <p className="garden-text-muted text-sm font-black">
              {t(language, "changeLanguage")}
            </p>
            <select
              aria-label={t(language, "changeLanguage")}
              value={language}
              onChange={(event) => {
                const nextLanguage = event.target.value;

                if (isSupportedLanguage(nextLanguage)) {
                  onLanguageSelect(nextLanguage);
                }
              }}
              className="garden-select settings-language-select"
            >
              {supportedLanguageOptions.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </section>

          <section className="settings-modal-section">
            <button
              type="button"
              className="settings-action-card"
              onClick={onOpenVoiceSettings}
            >
              <span className="garden-bubble grid h-11 w-11 shrink-0 place-items-center rounded-full">
                <Mic className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="settings-action-copy">
                <strong>{t(language, "voiceSettingsTitle")}</strong>
                <small>{t(language, "voiceSettingsSummary")}</small>
              </span>
              <SlidersHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
            </button>
          </section>

          <ThemePanel
            language={language}
            onThemeChange={onThemeChange}
            theme={theme}
          />

          {callState !== "idle" ? (
            <RemoteAudioPanel
              language={language}
              localInputVolume={localInputVolume}
              masterOutputVolume={masterOutputVolume}
              onLocalInputVolumeChange={onLocalInputVolumeChange}
              onMasterOutputVolumeChange={onMasterOutputVolumeChange}
              onRemoteVolumeChange={onRemoteVolumeChange}
              onScreenShareAudioVolumeChange={onScreenShareAudioVolumeChange}
              remoteParticipants={remoteParticipants}
              remoteVolumes={remoteVolumes}
              screenShareAudioVolume={screenShareAudioVolume}
            />
          ) : null}

          <ConnectionPathPanel
            connectionPathRows={connectionPathRows}
            connectionPathSummary={connectionPathSummary}
            language={language}
          />

          {canManageTurnRelay ? (
            <TurnRelayPanel
              language={language}
              turnRelayReady={turnRelayReady}
              turnStatus={turnStatus}
            />
          ) : null}
        </div>
      </section>
    </ModalBackdrop>
  );
}

function VoiceSettingsModal({
  audioOutputDevices,
  isAudioOutputSelectionSupported,
  isPreparingMedia,
  isReplacingMicrophone,
  isTestingMicrophone,
  language,
  localInputVolume,
  microphoneDevices,
  microphoneLevel,
  onClose,
  onAudioOutputDeviceChange,
  onLocalInputVolumeChange,
  onMicrophoneDeviceChange,
  onStartMicrophoneTest,
  onVoiceSettingCommit,
  onVoiceSettingChange,
  open,
  selectedAudioOutputDeviceId,
  selectedMicrophoneDeviceId,
  voiceSettings,
}: {
  audioOutputDevices: MediaDeviceInfo[];
  isAudioOutputSelectionSupported: boolean;
  isPreparingMedia: boolean;
  isReplacingMicrophone: boolean;
  isTestingMicrophone: boolean;
  language: Language;
  localInputVolume: number;
  microphoneDevices: MediaDeviceInfo[];
  microphoneLevel: MicrophoneLevelSnapshot;
  onClose: () => void;
  onAudioOutputDeviceChange: (deviceId: string) => void;
  onLocalInputVolumeChange: (value: string) => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onStartMicrophoneTest: () => void;
  onVoiceSettingCommit: (
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) => void;
  onVoiceSettingChange: (
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) => void;
  open: boolean;
  selectedAudioOutputDeviceId: string;
  selectedMicrophoneDeviceId: string;
  voiceSettings: MicrophoneProcessingSettings;
}) {
  if (!open) {
    return null;
  }

  const gateMeterStyle = {
    "--gate-threshold": unitPercentStyle(microphoneLevel.gateThreshold),
    "--noise-floor": unitPercentStyle(microphoneLevel.noiseFloor),
    "--voice-level": unitPercentStyle(microphoneLevel.level),
    "--voice-peak": unitPercentStyle(microphoneLevel.peak),
  } as CSSProperties;
  const gateStatusKey = microphoneLevel.isGateOpen
    ? "noiseGateOpen"
    : "noiseGateClosed";

  return (
    <ModalBackdrop onClose={onClose}>
      <section
        aria-labelledby="voice-settings-modal-title"
        aria-modal="true"
        className="settings-modal voice-settings-modal max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-hidden"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-ribbon" aria-hidden="true" />
        <header className="relative flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">

            <h2
              className="garden-title mt-2 text-2xl"
              id="voice-settings-modal-title"
            >
              {t(language, "voiceSettingsTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeSettings")}
            onClick={onClose}
            className="garden-icon-button settings-modal-close grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-modal-content voice-settings-content grid gap-4 px-5 pb-5">
          <section className="settings-modal-section voice-settings-section">
            <label className="voice-select-field">
              <span className="voice-control-label">
                {t(language, "microphoneDevice")}
              </span>
              <select
                value={selectedMicrophoneDeviceId}
                onChange={(event) => onMicrophoneDeviceChange(event.target.value)}
                disabled={isReplacingMicrophone}
                className="garden-select"
              >
                <option value="">
                  {t(language, "defaultMicrophoneDevice")}
                </option>
                {selectedMicrophoneDeviceId &&
                !microphoneDevices.some(
                  (device) => device.deviceId === selectedMicrophoneDeviceId,
                ) ? (
                  <option value={selectedMicrophoneDeviceId}>
                    {t(language, "selectedMicrophoneDevice")}
                  </option>
                ) : null}
                {microphoneDevices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label ||
                      `${t(language, "microphoneDevice")} ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            {isReplacingMicrophone ? (
              <p className="voice-settings-note">
                {t(language, "switchingMicrophone")}
              </p>
            ) : null}
            <label className="voice-select-field">
              <span className="voice-control-label">
                {t(language, "microphoneChannelMode")}
              </span>
              <select
                value={voiceSettings.microphoneChannelMode}
                onChange={(event) =>
                  onVoiceSettingChange(
                    "microphoneChannelMode",
                    event.target.value,
                  )
                }
                className="garden-select"
              >
                {microphoneChannelModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {microphoneChannelModeLabel(language, mode)}
                  </option>
                ))}
              </select>
              <small>{t(language, "microphoneChannelHelp")}</small>
            </label>
            <label className="voice-select-field">
              <span className="voice-control-label">
                {t(language, "audioOutputDevice")}
              </span>
              <select
                value={selectedAudioOutputDeviceId}
                onChange={(event) => onAudioOutputDeviceChange(event.target.value)}
                disabled={!isAudioOutputSelectionSupported}
                className="garden-select"
              >
                <option value="">
                  {t(language, "defaultAudioOutputDevice")}
                </option>
                {selectedAudioOutputDeviceId &&
                !audioOutputDevices.some(
                  (device) => device.deviceId === selectedAudioOutputDeviceId,
                ) ? (
                  <option value={selectedAudioOutputDeviceId}>
                    {t(language, "selectedAudioOutputDevice")}
                  </option>
                ) : null}
                {audioOutputDevices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label ||
                      `${t(language, "audioOutputDevice")} ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            {!isAudioOutputSelectionSupported ? (
              <p className="voice-settings-note">
                {t(language, "audioOutputDeviceUnsupported")}
              </p>
            ) : null}
          </section>

          <section className="settings-modal-section voice-settings-section">
            <div className="voice-range-row">
              <div className="voice-range-copy">
                <span className="voice-control-label">
                  {t(language, "noiseSuppression")}
                </span>
                <small>{t(language, "noiseSuppressionHelp")}</small>
              </div>
              <span className="voice-range-value">
                {Math.round(voiceSettings.noiseReduction * 100)}%
              </span>
              <input
                aria-label={t(language, "noiseSuppression")}
                max="100"
                min="0"
                onChange={(event) =>
                  onVoiceSettingChange(
                    "noiseReduction",
                    event.target.value,
                  )
                }
                onBlur={(event) =>
                  onVoiceSettingCommit(
                    "noiseReduction",
                    event.currentTarget.value,
                  )
                }
                onKeyUp={(event) => {
                  if (
                    [
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "End",
                      "Home",
                      "PageDown",
                      "PageUp",
                    ].includes(event.key)
                  ) {
                    onVoiceSettingCommit(
                      "noiseReduction",
                      event.currentTarget.value,
                    );
                  }
                }}
                onPointerUp={(event) =>
                  onVoiceSettingCommit(
                    "noiseReduction",
                    event.currentTarget.value,
                  )
                }
                step="1"
                type="range"
                value={Math.round(voiceSettings.noiseReduction * 100)}
                style={{ "--range-fill": `${Math.round(voiceSettings.noiseReduction * 100)}%` } as CSSProperties}
              />
            </div>

            <div className="voice-range-row">
              <div className="voice-range-copy">
                <span className="voice-control-label">
                  {t(language, "noiseGate")}
                </span>
                <small>{t(language, "noiseGateHelp")}</small>
              </div>
              <span className="voice-range-value">
                {voiceSettings.noiseGate <= 0
                  ? t(language, "off")
                  : `${Math.round(voiceSettings.noiseGate * 100)}%`}
              </span>
              <div
                className={`voice-gate-meter ${
                  microphoneLevel.isGateOpen ? "is-open" : "is-closed"
                }`}
                style={gateMeterStyle}
              >
                <div className="voice-gate-meter-status">
                  <span>{t(language, "noiseGateMeter")}</span>
                  <strong>{t(language, gateStatusKey)}</strong>
                </div>
                <div
                  aria-label={t(language, "voiceLevel")}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={unitPercent(microphoneLevel.level)}
                  className="voice-gate-meter-track"
                  role="meter"
                >
                  <span className="voice-gate-meter-noise" aria-hidden="true" />
                  <span className="voice-gate-meter-fill" aria-hidden="true" />
                  <span className="voice-gate-meter-peak" aria-hidden="true" />
                  <span
                    className="voice-gate-meter-threshold"
                    aria-hidden="true"
                  />
                </div>
                <div className="voice-gate-meter-legend">
                  <span>
                    <i className="voice-gate-meter-swatch noise" />
                    {t(language, "noiseFloor")}
                  </span>
                  <span>
                    <i className="voice-gate-meter-swatch threshold" />
                    {t(language, "gateThreshold")}
                  </span>
                </div>
              </div>
              <input
                aria-label={t(language, "noiseGate")}
                max="100"
                min="0"
                onChange={(event) =>
                  onVoiceSettingChange("noiseGate", event.target.value)
                }
                step="1"
                type="range"
                value={Math.round(voiceSettings.noiseGate * 100)}
                style={{ "--range-fill": `${Math.round(voiceSettings.noiseGate * 100)}%` } as CSSProperties}
              />
            </div>

            <div className="voice-range-row">
              <div className="voice-range-copy">
                <span className="voice-control-label">
                  {t(language, "mixerMicInput")}
                </span>
                <small>{t(language, "mixerMicInputVolume")}</small>
              </div>
              <span className="voice-range-value">
                {Math.round(localInputVolume * 100)}%
              </span>
              <input
                aria-label={t(language, "mixerMicInputVolume")}
                max="100"
                min="0"
                onChange={(event) => onLocalInputVolumeChange(event.target.value)}
                step="1"
                type="range"
                value={Math.round(localInputVolume * 100)}
                style={{ "--range-fill": `${Math.round(localInputVolume * 100)}%` } as CSSProperties}
              />
            </div>
          </section>

          <section className="settings-modal-section voice-settings-section">
            <div className="voice-test-panel">
              <div className="min-w-0">
                <h3 className="garden-text-ink text-base font-black">
                  {t(language, "micTestTitle")}
                </h3>
                <p className="garden-muted mt-1 text-sm font-bold leading-snug">
                  {t(language, "micTestHelp")}
                </p>
              </div>
              <button
                type="button"
                onClick={onStartMicrophoneTest}
                disabled={isPreparingMedia}
                className={`garden-button ${
                  isTestingMicrophone
                    ? "garden-button-secondary"
                    : "garden-button-primary"
                } voice-test-button`}
              >
                {isTestingMicrophone ? (
                  <MicOff className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Mic className="h-5 w-5" aria-hidden="true" />
                )}
                <span>
                  {isTestingMicrophone
                    ? t(language, "stopMicTest")
                    : t(language, "startMicTest")}
                </span>
              </button>
            </div>
            <p className="voice-settings-note">
              {t(language, "clippingProtectionHelp")}
            </p>
          </section>
        </div>
      </section>
    </ModalBackdrop>
  );
}

function ScreenShareSettingsModal({
  isApplyingScreenQuality,
  isScreenSharing,
  language,
  onApply,
  onClose,
  onNumberChange,
  onResolutionChange,
  onSelectPreset,
  onStart,
  onUpdateQuality,
  open,
  screenShareQuality,
  screenShareStats,
  selectedScreenResolution,
}: {
  isApplyingScreenQuality: boolean;
  isScreenSharing: boolean;
  language: Language;
  onApply: () => void;
  onClose: () => void;
  onNumberChange: (
    field: "width" | "height" | "frameRate" | "bitrateKbps",
    value: string,
  ) => void;
  onResolutionChange: (value: string) => void;
  onSelectPreset: (presetId: ScreenSharePresetId) => void;
  onStart: () => void;
  onUpdateQuality: (
    patch: Partial<Omit<ScreenShareQualitySettings, "presetId">>,
  ) => void;
  open: boolean;
  screenShareQuality: ScreenShareQualitySettings;
  screenShareStats: ScreenShareStatsSnapshot | null;
  selectedScreenResolution: string;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="screen-quality-modal-backdrop fixed inset-0 z-50 grid place-items-center px-4 py-6"
      onClick={onClose}
    >
      <section
        aria-labelledby="screen-quality-modal-title"
        aria-modal="true"
        className="screen-quality-modal w-full max-w-2xl overflow-hidden"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="screen-quality-modal-header">
          <div className="min-w-0">

            <h2
              id="screen-quality-modal-title"
              className="garden-title mt-1 text-2xl"
            >
              {isScreenSharing
                ? t(language, "screenQualityLiveTitle")
                : t(language, "screenQualityTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t(language, "closeScreenQuality")}
            onClick={onClose}
            className="garden-icon-button grid h-10 w-10 place-items-center rounded-full"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="screen-quality-content">
          <p className="screen-quality-help">
            {isScreenSharing
              ? t(language, "screenQualityLiveHelp")
              : t(language, "screenQualityHelp")}
          </p>

          <section className="screen-quality-section">
            <h3>{t(language, "screenQualityPreset")}</h3>
            <div className="screen-quality-presets">
              {screenSharePresetIds.map((presetId) => (
                <button
                  key={presetId}
                  type="button"
                  onClick={() => onSelectPreset(presetId)}
                  aria-pressed={screenShareQuality.presetId === presetId}
                  className={`screen-quality-preset ${
                    screenShareQuality.presetId === presetId
                      ? "is-selected"
                      : ""
                  }`}
                >
                  <span className="screen-quality-preset-title">
                    {screenSharePresetLabel(language, presetId)}
                    <span className="screen-quality-selection-mark" aria-hidden="true"><Check /></span>
                  </span>
                  <small>{screenSharePresetHelp(language, presetId, screenShareQuality)}</small>
                </button>
              ))}
            </div>
          </section>

          <details className="paper-disclosure screen-quality-advanced" key={screenShareQuality.presetId === "custom" ? "custom" : "preset"} open={screenShareQuality.presetId === "custom" ? true : undefined}>
            <summary>{t(language, "advancedSettings")}</summary>
          <section className="screen-quality-section">
            <div className="screen-quality-fields">
              <label className="screen-quality-field">
                <span>{t(language, "screenQualityResolution")}</span>
                <select
                  value={selectedScreenResolution}
                  onChange={(event) => onResolutionChange(event.target.value)}
                  className="screen-quality-input"
                >
                  {screenShareResolutionOptions.map((option) => (
                    <option
                      key={`${option.width}x${option.height}`}
                      value={`${option.width}x${option.height}`}
                    >
                      {option.label} ({option.width}x{option.height})
                    </option>
                  ))}
                  <option value="custom">
                    {t(language, "screenQualityCustom")}
                  </option>
                </select>
              </label>

              <label className="screen-quality-field">
                <span>{t(language, "screenQualityWidth")}</span>
                <input
                  type="number"
                  min={640}
                  max={3840}
                  step={160}
                  value={screenShareQuality.width}
                  onChange={(event) =>
                    onNumberChange("width", event.target.value)
                  }
                  className="screen-quality-input"
                />
              </label>

              <label className="screen-quality-field">
                <span>{t(language, "screenQualityHeight")}</span>
                <input
                  type="number"
                  min={360}
                  max={2160}
                  step={90}
                  value={screenShareQuality.height}
                  onChange={(event) =>
                    onNumberChange("height", event.target.value)
                  }
                  className="screen-quality-input"
                />
              </label>

              <label className="screen-quality-field">
                <span>{t(language, "screenQualityFrameRate")}</span>
                <input
                  type="number"
                  min={5}
                  max={60}
                  step={1}
                  value={screenShareQuality.frameRate}
                  onChange={(event) =>
                    onNumberChange("frameRate", event.target.value)
                  }
                  className="screen-quality-input"
                />
              </label>

              <label className="screen-quality-field">
                <span>{t(language, "screenQualityBitrate")}</span>
                <input
                  type="number"
                  min={500}
                  max={30000}
                  step={500}
                  value={screenShareQuality.bitrateKbps}
                  onChange={(event) =>
                    onNumberChange("bitrateKbps", event.target.value)
                  }
                  className="screen-quality-input"
                />
              </label>
            </div>
          </section>

          <section className="screen-quality-section">
            <label className="screen-quality-toggle">
              <input
                type="checkbox"
                checked={screenShareQuality.prioritizeScreen}
                onChange={(event) =>
                  onUpdateQuality({
                    prioritizeScreen: event.target.checked,
                  })
                }
              />
              <span>
                <strong>{t(language, "screenQualityPrioritizeScreen")}</strong>
                <small>
                  {t(language, "screenQualityPrioritizeScreenHelp")}
                </small>
              </span>
            </label>
          </section>

          </details>
          {isScreenSharing ? (
            <section className="screen-quality-section screen-quality-stats">
              <h3>{t(language, "screenQualityActual")}</h3>
              {screenShareStats ? (
                <dl>
                  <div><dt>{t(language, "screenQualityRecipient")}</dt><dd>{screenShareStats.recipient ?? "—"}</dd></div>
                  <div><dt>{t(language, "screenQualityCodec")}</dt><dd>{screenShareStats.codec ?? "—"}</dd></div>
                  <div><dt>{t(language, "screenQualityEncoder")}</dt><dd>{screenShareStats.encoder ?? t(language, "screenQualityNotReported")}</dd></div>
                  <div><dt>{t(language, "screenQualityEfficient")}</dt><dd>{screenShareStats.powerEfficient === undefined ? t(language, "screenQualityNotReported") : screenShareStats.powerEfficient ? t(language, "screenQualityYes") : t(language, "screenQualityNo")}</dd></div>
                  <div><dt>{t(language, "screenQualityEncodeTime")}</dt><dd>{screenShareStats.encodeMs !== undefined ? `${screenShareStats.encodeMs.toFixed(1)} ms` : "—"}</dd></div>
                  <div><dt>{t(language, "screenQualityLimit")}</dt><dd>{screenShareStats.bitrateLimitKbps !== undefined ? `${screenShareStats.bitrateLimitKbps} kbps` : "—"}</dd></div>
                  <div><dt>{t(language, "screenQualityBottleneck")}</dt><dd>{screenShareStats.limitation === "cpu" ? t(language, "screenQualityCpu") : screenShareStats.limitation === "bandwidth" ? t(language, "screenQualityNetwork") : screenShareStats.limitation === "none" ? t(language, "screenQualityNone") : screenShareStats.limitation ?? t(language, "screenQualityNotReported")}</dd></div>
                  <div>
                    <dt>{t(language, "screenQualityResolution")}</dt>
                    <dd>
                      {screenShareStats.width && screenShareStats.height
                        ? `${screenShareStats.width}x${screenShareStats.height}`
                        : "-"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(language, "screenQualityFrameRate")}</dt>
                    <dd>
                      {screenShareStats.fps
                        ? `${Math.round(screenShareStats.fps)} ${t(
                            language,
                            "screenQualityFpsUnit",
                          )}`
                        : "-"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(language, "screenQualityBitrate")}</dt>
                    <dd>
                      {screenShareStats.bitrateKbps
                        ? `${screenShareStats.bitrateKbps} ${t(
                            language,
                            "screenQualityKbps",
                          )}`
                        : "-"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(language, "screenQualityPath")}</dt>
                    <dd>
                      {screenShareStats.path === "relay"
                        ? t(language, "screenQualityRelay")
                        : screenShareStats.path === "direct"
                          ? t(language, "screenQualityDirect")
                          : t(language, "screenQualityUnknownPath")}
                      {screenShareStats.roundTripMs
                        ? ` / ${screenShareStats.roundTripMs} ms`
                        : ""}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p>{t(language, "screenQualityWaitingStats")}</p>
              )}
            </section>
          ) : null}

        </div>
          <div className="screen-quality-actions">
            <button
              type="button"
              onClick={onClose}
              className="garden-button garden-button-quiet h-12 px-4 text-base"
            >
              {t(language, "screenQualityCancel")}
            </button>
            <button
              type="button"
              onClick={isScreenSharing ? onApply : onStart}
              disabled={isApplyingScreenQuality}
              className="garden-button garden-button-primary h-12 px-4 text-base"
            >
              {isApplyingScreenQuality
                ? t(language, "screenQualityApplying")
                : isScreenSharing
                  ? t(language, "screenQualityApply")
                  : t(language, "screenQualityStart")}
            </button>
          </div>
      </section>
    </div>
  );
}

export const CallRoomModals = memo(function CallRoomModals({
  isRoomHost,
  audioOutputDevices,
  callState,
  canManageTurnRelay,
  connectionPathRows,
  connectionPathSummary,
  isApplyingScreenQuality,
  isAudioOutputSelectionSupported,
  isPreparingMedia,
  isReplacingMicrophone,
  isScreenSharing,
  isTestingMicrophone,
  language,
  localInputVolume,
  masterOutputVolume,
  mediaLayoutMode,
  microphoneDevices,
  microphoneLevel,
  onApplyScreenShareQuality,
  onAudioOutputDeviceChange,
  onCloseLayoutPicker,
  onCloseLeaveConfirmation,
  onCloseScreenShareSettings,
  onCloseSettings,
  onCloseSurfacePicker,
  onCloseVoiceSettings,
  onLanguageSelect,
  onLeaveCall,
  onLocalInputVolumeChange,
  onMasterOutputVolumeChange,
  onMediaLayoutModeChange,
  onMicrophoneDeviceChange,
  onOpenVoiceSettings,
  onRemoteVolumeChange,
  onScreenShareNumberChange,
  onScreenShareAudioVolumeChange,
  onScreenShareResolutionChange,
  onSelectScreenSharePreset,
  onSelectSurface,
  onStartMicrophoneTest,
  onStartScreenShareFromSettings,
  onThemeChange,
  onUpdateScreenShareQuality,
  onVoiceSettingCommit,
  onVoiceSettingChange,
  orderedSurfaces,
  remoteParticipants,
  remoteVolumes,
  screenShareQuality,
  screenShareStats,
  screenShareAudioVolume,
  selectedAudioOutputDeviceId,
  selectedMicrophoneDeviceId,
  selectedScreenResolution,
  showLayoutPicker,
  showLeaveConfirmation,
  showScreenShareSettings,
  showSettings,
  showVoiceSettings,
  surfacePickerSelectedId,
  surfacePickerTarget,
  surfacePickerTitleKey,
  theme,
  turnRelayReady,
  turnStatus,
  voiceSettings,
}: {
  isRoomHost: boolean;
  audioOutputDevices: MediaDeviceInfo[];
  callState: CallState;
  canManageTurnRelay: boolean;
  connectionPathRows: PeerConnectionPathSnapshot[];
  connectionPathSummary: ConnectionPathSummary;
  isApplyingScreenQuality: boolean;
  isAudioOutputSelectionSupported: boolean;
  isPreparingMedia: boolean;
  isReplacingMicrophone: boolean;
  isScreenSharing: boolean;
  isTestingMicrophone: boolean;
  language: Language;
  localInputVolume: number;
  masterOutputVolume: number;
  mediaLayoutMode: MediaLayoutMode;
  microphoneDevices: MediaDeviceInfo[];
  microphoneLevel: MicrophoneLevelSnapshot;
  onApplyScreenShareQuality: () => void;
  onAudioOutputDeviceChange: (deviceId: string) => void;
  onCloseLayoutPicker: () => void;
  onCloseLeaveConfirmation: () => void;
  onCloseScreenShareSettings: () => void;
  onCloseSettings: () => void;
  onCloseSurfacePicker: () => void;
  onCloseVoiceSettings: () => void;
  onLanguageSelect: (language: Language) => void;
  onLeaveCall: () => void;
  onLocalInputVolumeChange: (value: string) => void;
  onMasterOutputVolumeChange: (value: string) => void;
  onMediaLayoutModeChange: (mode: MediaLayoutMode) => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onOpenVoiceSettings: () => void;
  onRemoteVolumeChange: (participantId: string, value: string) => void;
  onScreenShareAudioVolumeChange: (value: string) => void;
  onScreenShareNumberChange: (
    field: "width" | "height" | "frameRate" | "bitrateKbps",
    value: string,
  ) => void;
  onScreenShareResolutionChange: (value: string) => void;
  onSelectScreenSharePreset: (presetId: ScreenSharePresetId) => void;
  onSelectSurface: (surfaceId: MediaSurfaceId) => void;
  onStartMicrophoneTest: () => void;
  onStartScreenShareFromSettings: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onUpdateScreenShareQuality: (
    patch: Partial<Omit<ScreenShareQualitySettings, "presetId">>,
  ) => void;
  onVoiceSettingCommit: (
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) => void;
  onVoiceSettingChange: (
    field: keyof MicrophoneProcessingSettings,
    value: string,
  ) => void;
  orderedSurfaces: MediaSurface[];
  remoteParticipants: RemoteAudioParticipant[];
  remoteVolumes: Record<string, number>;
  screenShareQuality: ScreenShareQualitySettings;
  screenShareStats: ScreenShareStatsSnapshot | null;
  screenShareAudioVolume: number;
  selectedAudioOutputDeviceId: string;
  selectedMicrophoneDeviceId: string;
  selectedScreenResolution: string;
  showLayoutPicker: boolean;
  showLeaveConfirmation: boolean;
  showScreenShareSettings: boolean;
  showSettings: boolean;
  showVoiceSettings: boolean;
  surfacePickerSelectedId: MediaSurfaceId | null;
  surfacePickerTarget: SurfacePickerTarget | null;
  surfacePickerTitleKey: TranslationKey;
  theme: ThemeMode;
  turnRelayReady: boolean;
  turnStatus: TurnStatus | null;
  voiceSettings: MicrophoneProcessingSettings;
}) {
  return (
    <>
      <SurfacePickerModal
        language={language}
        onClose={onCloseSurfacePicker}
        onSelectSurface={onSelectSurface}
        open={Boolean(surfacePickerTarget)}
        orderedSurfaces={orderedSurfaces}
        selectedSurfaceId={surfacePickerSelectedId}
        titleKey={surfacePickerTitleKey}
      />
      <LeaveConfirmationModal
        isRoomHost={isRoomHost}
        language={language}
        onClose={onCloseLeaveConfirmation}
        onLeave={onLeaveCall}
        open={showLeaveConfirmation}
      />
      <LayoutPickerModal
        language={language}
        mediaLayoutMode={mediaLayoutMode}
        onChange={onMediaLayoutModeChange}
        onClose={onCloseLayoutPicker}
        open={showLayoutPicker}
      />
      <CallSettingsModal
        callState={callState}
        canManageTurnRelay={canManageTurnRelay}
        connectionPathRows={connectionPathRows}
        connectionPathSummary={connectionPathSummary}
        language={language}
        localInputVolume={localInputVolume}
        masterOutputVolume={masterOutputVolume}
        onClose={onCloseSettings}
        onLanguageSelect={onLanguageSelect}
        onLocalInputVolumeChange={onLocalInputVolumeChange}
        onMasterOutputVolumeChange={onMasterOutputVolumeChange}
        onOpenVoiceSettings={onOpenVoiceSettings}
        onRemoteVolumeChange={onRemoteVolumeChange}
        onScreenShareAudioVolumeChange={onScreenShareAudioVolumeChange}
        onThemeChange={onThemeChange}
        open={showSettings}
        remoteParticipants={remoteParticipants}
        remoteVolumes={remoteVolumes}
        screenShareAudioVolume={screenShareAudioVolume}
        theme={theme}
        turnRelayReady={turnRelayReady}
        turnStatus={turnStatus}
      />
      <VoiceSettingsModal
        audioOutputDevices={audioOutputDevices}
        isAudioOutputSelectionSupported={isAudioOutputSelectionSupported}
        isPreparingMedia={isPreparingMedia}
        isReplacingMicrophone={isReplacingMicrophone}
        isTestingMicrophone={isTestingMicrophone}
        language={language}
        localInputVolume={localInputVolume}
        microphoneDevices={microphoneDevices}
        microphoneLevel={microphoneLevel}
        onClose={onCloseVoiceSettings}
        onAudioOutputDeviceChange={onAudioOutputDeviceChange}
        onLocalInputVolumeChange={onLocalInputVolumeChange}
        onMicrophoneDeviceChange={onMicrophoneDeviceChange}
        onStartMicrophoneTest={onStartMicrophoneTest}
        onVoiceSettingCommit={onVoiceSettingCommit}
        onVoiceSettingChange={onVoiceSettingChange}
        open={showVoiceSettings}
        selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
        selectedMicrophoneDeviceId={selectedMicrophoneDeviceId}
        voiceSettings={voiceSettings}
      />
      <ScreenShareSettingsModal
        isApplyingScreenQuality={isApplyingScreenQuality}
        isScreenSharing={isScreenSharing}
        language={language}
        onApply={onApplyScreenShareQuality}
        onClose={onCloseScreenShareSettings}
        onNumberChange={onScreenShareNumberChange}
        onResolutionChange={onScreenShareResolutionChange}
        onSelectPreset={onSelectScreenSharePreset}
        onStart={onStartScreenShareFromSettings}
        onUpdateQuality={onUpdateScreenShareQuality}
        open={showScreenShareSettings}
        screenShareQuality={screenShareQuality}
        screenShareStats={screenShareStats}
        selectedScreenResolution={selectedScreenResolution}
      />
    </>
  );
});
