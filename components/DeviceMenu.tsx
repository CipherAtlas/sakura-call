"use client";

import { ChevronUp, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function DeviceMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(360);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function measure() {
      const top = buttonRef.current?.getBoundingClientRect().top ?? 376;
      setAvailableHeight(Math.max(100, top - 16));
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="setup-device-menu-wrap">
      <button ref={buttonRef} type="button" className="garden-button setup-device-menu-button" aria-expanded={open} aria-controls="setup-device-menu" onClick={() => {
        setAvailableHeight(Math.max(100, (buttonRef.current?.getBoundingClientRect().top ?? 376) - 16));
        setOpen(!open);
      }}>
        <SlidersHorizontal aria-hidden="true" /><span>{label}</span><ChevronUp aria-hidden="true" />
      </button>
      {open ? <div id="setup-device-menu" role="region" aria-label={label} className="setup-device-menu" style={{ maxHeight: availableHeight }}>{children}</div> : null}
    </div>
  );
}
