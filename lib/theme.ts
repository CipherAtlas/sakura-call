"use client";

export type ResolvedThemeMode = "light" | "dark";
export type ThemeMode = "system" | ResolvedThemeMode;

const themeStorageKey = "sakura.theme";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function systemTheme(): ResolvedThemeMode {
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

export function resolveTheme(theme: ThemeMode): ResolvedThemeMode {
  return theme === "system" ? systemTheme() : theme;
}

export function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedTheme = resolveTheme(theme);
  document.documentElement.dataset.sakuraTheme = resolvedTheme;
  document.documentElement.dataset.sakuraThemePreference = theme;
  document.documentElement.style.colorScheme = resolvedTheme;
}

export function getSavedTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const savedTheme = window.localStorage.getItem(themeStorageKey);
  return isThemeMode(savedTheme) ? savedTheme : "light";
}

export function saveTheme(theme: ThemeMode) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(themeStorageKey, theme);
  applyTheme(theme);
}

export function watchSystemTheme(theme: ThemeMode) {
  if (typeof window === "undefined" || theme !== "system") {
    return () => undefined;
  }

  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

  if (!mediaQuery) {
    return () => undefined;
  }

  function handleChange() {
    applyTheme("system");
  }

  mediaQuery.addEventListener("change", handleChange);
  return () => mediaQuery.removeEventListener("change", handleChange);
}
