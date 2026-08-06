"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: Biome does not resolve this package's conditional exports; TypeScript does.
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";
import type { ReactNode } from "react";
import type { ResolvedTheme, ThemeChoice } from "./theme-state.ts";

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
      {children}
    </NextThemesProvider>
  );
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
