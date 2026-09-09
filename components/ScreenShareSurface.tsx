"use client";

import { Maximize2, RotateCcw, ScreenShare, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { t, type Language } from "@/lib/i18n";
import type { MediaSurface, MediaSurfacePlacement } from "./VideoGrid";

export function ScreenShareSurface({ surface, slot, language, fullscreenLabel, selectLabel, onFullscreenSurface, onSelectSurface }: {
  surface: MediaSurface;
  slot: MediaSurfacePlacement;
  language: Language;
  fullscreenLabel: string;
  selectLabel: string;
  onFullscreenSurface?: (id: string) => void;
  onSelectSurface?: (id: string, slot: MediaSurfacePlacement) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });
  const pointerStart = useRef({ x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = surface.stream;
    const play = () => { void video.play().catch(() => undefined); };
    video.addEventListener("loadedmetadata", play);
    play();
    return () => { video.removeEventListener("loadedmetadata", play); video.srcObject = null; };
  }, [surface.stream]);

  useEffect(() => {
    const observer = new ResizeObserver(() => setOffset({ x: 0, y: 0 }));
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  function toggleZoom() {
    setZoomed(current => !current);
    setOffset({ x: 0, y: 0 });
  }

  function pan(x: number, y: number) {
    const box = viewportRef.current?.getBoundingClientRect();
    if (!box) return;
    const video = videoRef.current;
    const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : box.width / box.height;
    const fitWidth = Math.min(box.width, box.height * ratio);
    const fitHeight = Math.min(box.height, box.width / ratio);
    const maxX = Math.max(0, (fitWidth * 2 - box.width) / 2);
    const maxY = Math.max(0, (fitHeight * 2 - box.height) / 2);
    setOffset({ x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) });
  }

  function release(event: PointerEvent<HTMLDivElement>) {
    if (event.type === "pointerup" && Math.hypot(event.clientX - pointerStart.current.x, event.clientY - pointerStart.current.y) < 10) {
      const previous = lastTap.current;
      if (Date.now() - previous.time < 320 && Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 30) {
        toggleZoom();
        lastTap.current.time = 0;
      } else lastTap.current = { time: Date.now(), x: event.clientX, y: event.clientY };
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <article className={`media-surface screen-surface shared-screen-surface is-${slot}`}>
    <header className="shared-screen-header">
      <button type="button" className="shared-screen-title" aria-label={selectLabel} onClick={() => onSelectSurface?.(surface.id, slot)}>
        <ScreenShare aria-hidden="true" /><span>{surface.label}</span>
      </button>
      <div className="shared-screen-actions">
        <button type="button" className="shared-screen-zoom" aria-pressed={zoomed} aria-label={t(language, zoomed ? "resetScreenZoom" : "zoomScreen")} onClick={toggleZoom}>
          {zoomed ? <RotateCcw aria-hidden="true" /> : <ZoomIn aria-hidden="true" />}
        </button>
        {onFullscreenSurface ? <button type="button" aria-label={fullscreenLabel} onClick={() => onFullscreenSurface(surface.id)}><Maximize2 aria-hidden="true" /></button> : null}
      </div>
    </header>
    <div ref={viewportRef} className={`shared-screen-viewport ${zoomed ? "is-zoomed" : ""}`} tabIndex={0}
      aria-label={t(language, zoomed ? "screenPanHelp" : "zoomScreen")}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleZoom(); }
        if (event.key === "Escape" && zoomed) { event.preventDefault(); event.stopPropagation(); setZoomed(false); setOffset({ x: 0, y: 0 }); }
        if (zoomed && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); pan(offset.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), offset.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0));
        }
      }}
      onPointerDown={event => {
        pointerStart.current = { x: event.clientX, y: event.clientY };
        if (zoomed) { dragRef.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }
      }}
      onPointerMove={event => { const drag = dragRef.current; if (drag) pan(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); }}
      onPointerUp={release} onPointerCancel={release}>
      <video ref={videoRef} autoPlay muted playsInline className="shared-screen-video" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoomed ? 2 : 1})` }} />
    </div>
  </article>;
}
