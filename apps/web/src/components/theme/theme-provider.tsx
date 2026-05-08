"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { buildThemeCookie, type ResolvedTheme, THEME_KEY, type ThemeChoice } from "./theme-state.ts";

interface ThemeContextValue {
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemeChoice) => void;
  /** What the user picked. `"system"` means "track OS." */
  theme: ThemeChoice;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the current theme choice from the `pdpp-theme` cookie. The cookie is
 * the single source of truth so the server (which renders the initial
 * `data-theme` and `dark` class on `<html>`) and the client agree on first
 * paint with no hydration mismatch.
 */
function readStoredChoice(): ThemeChoice {
  if (typeof document === "undefined") {
    return "system";
  }
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(`${THEME_KEY}=`));
  if (!match) {
    return "system";
  }
  const value = decodeURIComponent(match.slice(THEME_KEY.length + 1));
  if (value === "light" || value === "dark") {
    return value;
  }
  return "system";
}

function readSystemPreference(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyResolvedTheme(theme: ThemeChoice, resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = resolved;
}

function persistThemeChoice(next: ThemeChoice): void {
  if (typeof document === "undefined") {
    return;
  }
  // Next.js sets `Secure` automatically on cookies it serializes via
  // `cookies()`, but we're writing client-side here so we handle it
  // ourselves. `window.isSecureContext` is `true` on HTTPS and on
  // `localhost`; we only emit `Secure` on real HTTPS to avoid breaking
  // local dev cookies. (Browsers reject `Secure` cookies set from a
  // non-HTTPS origin even if `isSecureContext` is true on localhost.)
  const isProduction = window.location.protocol === "https:";
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't supported in Safari/Firefox; value is built from a hardcoded allowlist in buildThemeCookie.
  document.cookie = buildThemeCookie(next, isProduction);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // First paint is server-rendered from the cookie (see RootLayout). The
  // client reads the same cookie so initial state matches what the server
  // produced. For "system", the server omits the `dark` class and CSS
  // resolves dark/light via `@media (prefers-color-scheme: dark)`.
  const [theme, setThemeState] = useState<ThemeChoice>(() => readStoredChoice());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemPreference());

  // Track OS preference whenever the user is in "system" mode.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(mql.matches ? "dark" : "light");
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Keep the DOM in lockstep with React state.
  useEffect(() => {
    applyResolvedTheme(theme, resolvedTheme);
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    persistThemeChoice(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
