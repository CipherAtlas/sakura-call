"use client";

import { Camera, CameraOff, ChevronRight, Ellipsis, Headphones, LayoutGrid, MessageSquare, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Settings, SlidersHorizontal, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { t, type Language } from "@/lib/i18n";

export function CallControls({
  language, muted, deafened, cameraOn, sharing, shareDisabled, moreOpen,
  onMoreChange, onMute, onDeafen, onCamera, onShare, onAudio, onVoice,
  onView, onConversation, onQuality, onSettings, onLeave,
  audioRef, conversationRef, audioOpen, conversationOpen, children,
}: {
  language: Language;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  sharing: boolean;
  shareDisabled: boolean;
  moreOpen: boolean;
  onMoreChange: (open: boolean) => void;
  onMute: () => void;
  onDeafen: () => void;
  onCamera: () => void;
  onShare: () => void;
  onAudio: () => void;
  onVoice: () => void;
  onView: () => void;
  onConversation: () => void;
  onQuality: () => void;
  onSettings: () => void;
  onLeave: () => void;
  audioRef: RefObject<HTMLButtonElement | null>;
  conversationRef: RefObject<HTMLButtonElement | null>;
  audioOpen: boolean;
  conversationOpen: boolean;
  children?: ReactNode;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!moreOpen) return;
    function positionMenu() {
      const button = moreRef.current;
      const panel = panelRef.current;
      if (!button || !panel) return;
      const anchor = button.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
      panel.style.bottom = `${window.innerHeight - anchor.top + 12}px`;
      panel.style.maxHeight = `${Math.max(80, anchor.top - 24)}px`;
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onMoreChange(false);
        moreRef.current?.focus();
      }
    }
    function handleOutside(event: PointerEvent) {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !moreRef.current?.contains(event.target)) {
        onMoreChange(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("pointerdown", handleOutside);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("pointerdown", handleOutside);
    };
  }, [moreOpen, onMoreChange]);

  function open(action: () => void) {
    onMoreChange(false);
    action();
  }

  return (
    <div className="paper-control-dock">
      {moreOpen ? (
        <div ref={panelRef} className="paper-more-panel" role="dialog" aria-label={t(language, "moreControls")} id="more-controls">
          <header><h2>{t(language, "moreControls")}</h2><button className="garden-icon-button" aria-label={t(language, "closeMoreControls")} onClick={() => { onMoreChange(false); moreRef.current?.focus(); }}><X aria-hidden="true" /></button></header>
          <div className="paper-more-options">
            <button onClick={() => open(onVoice)}><Headphones aria-hidden="true" /><span>{t(language, "audioDevicesTitle")}</span><ChevronRight aria-hidden="true" /></button>
            <button onClick={() => open(onView)}><LayoutGrid aria-hidden="true" /><span>{t(language, "viewLayout")}</span><ChevronRight aria-hidden="true" /></button>
            <button ref={conversationRef} onClick={onConversation} aria-expanded={conversationOpen} aria-haspopup="menu"><MessageSquare aria-hidden="true" /><span>{t(language, "openConversationModes")}</span><ChevronRight aria-hidden="true" /></button>
            {sharing ? <button onClick={() => open(onQuality)}><ScreenShare aria-hidden="true" /><span>{t(language, "openScreenQuality")}</span><ChevronRight aria-hidden="true" /></button> : null}
            <button onClick={() => open(onSettings)}><Settings aria-hidden="true" /><span>{t(language, "settings")}</span><ChevronRight aria-hidden="true" /></button>
          </div>
        </div>
      ) : null}
      <section className="paper-control-bar" aria-label={t(language, "callControls")}>
        <button className={`paper-control ${muted ? "is-muted" : ""}`} onClick={onMute} aria-label={t(language, muted ? "unmute" : "mute")} aria-pressed={muted}>{muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}<span>{t(language, "micControl")}</span></button>
        <button className={`paper-control ${deafened ? "is-muted" : ""}`} onClick={onDeafen} aria-label={t(language, deafened ? "undeafen" : "deafen")} aria-pressed={deafened}>{deafened ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}<span>{t(language, "deafenControl")}</span></button>
        <button className={`paper-control ${cameraOn ? "is-on" : ""}`} onClick={onCamera} aria-label={t(language, cameraOn ? "cameraOff" : "cameraOn")} aria-pressed={cameraOn}>{cameraOn ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}<span>{t(language, "cameraControl")}</span></button>
        <button className={`paper-control ${sharing ? "is-on" : ""}`} onClick={onShare} disabled={shareDisabled} aria-label={t(language, shareDisabled ? "screenShareUnavailable" : sharing ? "screenShareOn" : "screenShareOff")} aria-pressed={sharing}>{sharing ? <ScreenShareOff aria-hidden="true" /> : <ScreenShare aria-hidden="true" />}<span>{t(language, "shareControl")}</span></button>
        <button ref={audioRef} className={`paper-control paper-mixer-control ${audioOpen ? "is-on" : ""}`} onClick={() => open(onAudio)} aria-label={t(language, "audioMixerTitle")} aria-expanded={audioOpen} aria-controls="participant-volume-mixer" aria-haspopup="dialog"><SlidersHorizontal aria-hidden="true" /><span>{t(language, "mixerControl")}</span></button>
        <button className="paper-control paper-desktop-control" onClick={() => open(onVoice)}><Headphones aria-hidden="true" /><span>{t(language, "audioDevicesTitle")}</span></button>
        <button className="paper-control paper-desktop-control" onClick={() => open(onView)}><LayoutGrid aria-hidden="true" /><span>{t(language, "viewControl")}</span></button>
        <button ref={moreRef} className={`paper-control ${moreOpen ? "is-on" : ""}`} aria-label={t(language, "moreControls")} aria-expanded={moreOpen} aria-controls="more-controls" onClick={() => onMoreChange(!moreOpen)}><Ellipsis aria-hidden="true" /><span>{t(language, "moreControl")}</span></button>
        <button className="paper-control paper-leave" onClick={() => open(onLeave)} aria-label={t(language, "leaveCall")} aria-haspopup="dialog"><PhoneOff aria-hidden="true" /><span>{t(language, "leaveControl")}</span></button>
      </section>
      {children}
    </div>
  );
}
