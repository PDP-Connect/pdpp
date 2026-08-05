// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme/theme-provider.tsx";
import type { ResolvedTheme, ThemeChoice } from "@/components/theme/theme-state.ts";

// Concept-native theme control. Drives the SAME ThemeProvider/cookie as the
// operator-console ThemeToggle (@pdpp/operator-ui) — one source of truth for
// theme state, two renderings for two registers.
//
// A prior version exposed all three choices as visible text segments
// (Light | Dark | System). Owner feedback: against a masthead whose only
// other content is a wordmark, three quiet nav links, and a compact search
// field, three labelled segments were the loudest thing on the bar — visual
// weight disproportionate to how often the control is used.
//
// Checked real precedent before rebuilding (Mobbin's MCP tools were
// unreachable from this session — scoped to a different project directory —
// so this used direct inspection of the live sites instead): Vercel's and
// GitHub's marketing headers carry no visible theme control at all. Linear's
// docs header (linear.app/docs, structurally the closest analog: wordmark,
// search, nav, theme control, CTA) uses a single small icon button that
// cycles directly on click — confirmed by clicking it and reading
// `document.documentElement.dataset.theme`, which flipped light -> dark with
// no menu, dropdown, or popover involved. That is the pattern this now
// follows: one icon button, same three-state cycle the operator console
// button already uses (dark -> system -> light -> dark), rendered as inline
// SVG at currentColor — the same treatment already given the GitHub/Discord
// marks in icons.tsx — instead of the console's Lucide-derived button shell.
const NEXT: Record<ThemeChoice, ThemeChoice> = {
  dark: "system",
  light: "dark",
  system: "light",
};

const NEXT_LABEL: Record<ThemeChoice, string> = {
  dark: "Switch to system theme",
  light: "Switch to dark theme",
  system: "Switch to light theme",
};

const CURRENT_LABEL: Record<ThemeChoice, string> = {
  dark: "Theme: dark",
  light: "Theme: light",
  system: "Theme: system",
};

export function PdppThemeSwitch() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  // The DOM paints from the server/CSS-resolved theme on first frame; the
  // icon must not render from React state until after mount; otherwise an
  // SSR'd <html> with no explicit class can briefly show the wrong glyph
  // against the right surface. Placeholder keeps the same footprint so
  // nothing shifts once the real icon reveals.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <button
      aria-label={mounted ? `${CURRENT_LABEL[theme]}. ${NEXT_LABEL[theme]}.` : "Theme"}
      className="pdpp-theme-switch"
      data-testid="theme-toggle"
      onClick={() => setTheme(NEXT[theme])}
      title={mounted ? `${CURRENT_LABEL[theme]} — click to ${NEXT_LABEL[theme].toLowerCase()}` : "Theme"}
      type="button"
    >
      {mounted ? (
        <ThemeIcon resolved={resolvedTheme} theme={theme} />
      ) : (
        <span aria-hidden className="pdpp-theme-switch__icon" />
      )}
    </button>
  );
}

function ThemeIcon({ theme, resolved }: { theme: ThemeChoice; resolved: ResolvedTheme }) {
  if (theme === "system") {
    return <SystemIcon />;
  }
  return resolved === "dark" ? <MoonIcon /> : <SunIcon />;
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="pdpp-theme-switch__icon" focusable="false" viewBox="0 0 16 16">
      <circle cx="8" cy="8" fill="none" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M5.4 10.6l-1 1M12.6 12.6l-1-1M5.4 5.4l-1-1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="pdpp-theme-switch__icon" focusable="false" viewBox="0 0 16 16">
      <path
        d="M13.5 9.3A5.5 5.5 0 0 1 6.7 2.5 5.5 5.5 0 1 0 13.5 9.3z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg aria-hidden="true" className="pdpp-theme-switch__icon" focusable="false" viewBox="0 0 16 16">
      <rect fill="none" height="9" rx="1.25" stroke="currentColor" strokeWidth="1.2" width="12" x="2" y="3" />
      <path d="M6 14h4M8 12v2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
    </svg>
  );
}
