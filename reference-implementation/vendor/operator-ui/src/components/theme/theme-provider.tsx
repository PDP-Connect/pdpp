"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: Biome does not resolve this package's conditional exports; TypeScript does.
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";
import { type ReactNode, useEffect } from "react";
import { type ResolvedTheme, THEME_KEY, type ThemeChoice } from "./theme-state.ts";

interface ThemeContextValue {
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemeChoice) => void;
  /** What the user picked. `"system"` means "track OS." */
  theme: ThemeChoice;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      storageKey="pdpp-theme"
    >
      <ThemeCookieBridge />
      {children}
    </NextThemesProvider>
  );
}

/** Keep server-rendered reference pages on the same theme as the console. */
function ThemeCookieBridge() {
  const { theme } = useNextTheme();

  useEffect(() => {
    const choice: ThemeChoice = theme === "dark" || theme === "light" || theme === "system" ? theme : "system";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    // biome-ignore lint/suspicious/noDocumentCookie: this non-sensitive preference must reach the server-rendered reference pages
    document.cookie = `${THEME_KEY}=${encodeURIComponent(choice)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, [theme]);

  return null;
}

/**
 * Shared typed consumer API over next-themes. The fallbacks cover the initial
 * render before next-themes has resolved browser-only state.
 */
export function useTheme(): ThemeContextValue {
  const { resolvedTheme, setTheme, theme } = useNextTheme();

  return {
    resolvedTheme: resolvedTheme === "dark" ? "dark" : "light",
    setTheme,
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : "system",
  };
}
