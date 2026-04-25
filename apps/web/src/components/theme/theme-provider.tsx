"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { THEME_KEY } from "./theme-script.tsx";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemeChoice) => void;
  /** What the user picked. `"system"` means "track OS." */
  theme: ThemeChoice;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredChoice(): ThemeChoice {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore — treat as system
  }
  return "system";
}

function readSystemPreference(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initial state must match what the inline ThemeScript wrote to <html>,
  // otherwise React would tear down the class on first commit.
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

  // Cross-tab sync — if another tab changed the choice, mirror it here.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== THEME_KEY) {
        return;
      }
      if (event.newValue === "light" || event.newValue === "dark") {
        setThemeState(event.newValue);
      } else if (event.newValue === null) {
        setThemeState("system");
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Keep the DOM in lockstep with React state.
  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    try {
      if (next === "system") {
        window.localStorage.removeItem(THEME_KEY);
      } else {
        window.localStorage.setItem(THEME_KEY, next);
      }
    } catch {
      // storage may be disabled (private mode, sandbox); fall through —
      // the in-memory choice still applies for this tab/session.
    }
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
