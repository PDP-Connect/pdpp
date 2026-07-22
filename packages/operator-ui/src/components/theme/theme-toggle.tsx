"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { Button } from "../../ui/button.tsx";
import { useTheme } from "./theme-provider.tsx";
import type { ThemeChoice } from "./theme-state.ts";

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const NEXT_LABEL: Record<ThemeChoice, string> = {
  light: "Switch to dark theme",
  dark: "Switch to system theme",
  system: "Switch to light theme",
};

const CURRENT_LABEL: Record<ThemeChoice, string> = {
  light: "Theme: light",
  dark: "Theme: dark",
  system: "Theme: system",
};

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();

  // The DOM was painted with the server/CSS theme choice, so the icon
  // must avoid rendering the React-state-driven icon during the first
  // commit — otherwise an SSR'd <html> with no class causes a brief
  // mismatch between icon and surface. We render an inert placeholder
  // until mounted, then reveal the real toggle.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  function onClick() {
    setTheme(NEXT[theme]);
  }

  return (
    <Button
      aria-label={mounted ? `${CURRENT_LABEL[theme]}. ${NEXT_LABEL[theme]}.` : "Theme toggle"}
      className={className}
      data-testid="theme-toggle"
      // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
      onClick={onClick}
      size="icon-sm"
      title={mounted ? `${CURRENT_LABEL[theme]} — click to ${NEXT_LABEL[theme].toLowerCase()}` : "Theme"}
      type="button"
      variant="ghost"
    >
      {mounted ? <ThemeIcon resolved={resolvedTheme} theme={theme} /> : <PlaceholderIcon />}
    </Button>
  );
}

function ThemeIcon({ theme, resolved }: { theme: ThemeChoice; resolved: "light" | "dark" }) {
  if (theme === "system") {
    return <SystemIcon resolved={resolved} />;
  }
  return resolved === "dark" ? <MoonIcon /> : <SunIcon />;
}

function SunIcon() {
  return (
    <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 16 16" width="14">
      <title>Light theme</title>
      <circle cx="8" cy="8" r="3" />
      <path
        d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M5.4 10.6l-1 1M12.6 12.6l-1-1M5.4 5.4l-1-1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 16 16" width="14">
      <title>Dark theme</title>
      <path d="M13.5 9.3A5.5 5.5 0 0 1 6.7 2.5 5.5 5.5 0 1 0 13.5 9.3z" strokeLinejoin="round" />
    </svg>
  );
}

function SystemIcon({ resolved }: { resolved: "light" | "dark" }) {
  return (
    <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 16 16" width="14">
      <title>System theme ({resolved})</title>
      <rect height="9" rx="1.25" width="12" x="2" y="3" />
      <path d="M6 14h4M8 12v2" strokeLinecap="round" />
    </svg>
  );
}

function PlaceholderIcon() {
  // Same footprint as the real icons; invisible so layout doesn't shift
  // and no incorrect icon flashes before mount.
  return <span aria-hidden className="inline-block h-3.5 w-3.5" />;
}
