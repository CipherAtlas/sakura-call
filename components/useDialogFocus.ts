"use client";

import { useEffect } from "react";

export function useDialogFocus(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    let dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    if (!dialog) return;
    const focusable = () => Array.from(dialog!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length > 0);
    if (!dialog.contains(document.activeElement)) focusable()[0]?.focus();
    const observer = new MutationObserver(() => {
      const current = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
      if (current && current !== dialog) {
        dialog = current;
        focusable()[0]?.focus();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", handleKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
}
