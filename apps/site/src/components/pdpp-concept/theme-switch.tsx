// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useTheme } from "@pdpp/operator-ui/components/theme/theme-provider";
import { useEffect, useState } from "react";
import type { ResolvedTheme } from "@/components/theme/theme-state.ts";
import { cn } from "@/lib/utils.ts";

// Concept-native theme control. Drives the SAME ThemeProvider/cookie as the
// operator-console ThemeToggle (@pdpp/operator-ui) — one source of truth for
// theme state, two renderings for two registers.
//
// Two states, not three. Owner instruction, verbatim: "dark/light/system
// should be dark/light with the default based on system." "system" is not a
// state a reader picks; it is what happens before they pick anything —
// ThemeProvider resolves the saved choice and system preference before paint.
// (see theme-provider.tsx's readStoredChoice/readSystemPreference), so no UI
// is needed for it. A prior version cycled dark -> system -> light, which on
// an OS set to dark made "system" visually indistinguishable from "dark":
// pressing once appeared to do nothing.
//
// The cycle now flips the RESOLVED theme (what is actually painted), not the
// stored choice: dark-however-it-got-there -> light, light -> dark. The
// first press always writes an explicit cookie value (never "system" again),
// which then wins over the OS permanently, per the owner's instruction.
//
// One icon button rather than exposed segments — checked real precedent
// before building this (Mobbin's MCP tools were unreachable from this
// session, scoped to a different project directory, so this used direct
// inspection of the live sites instead): Linear's docs header (linear.app/
// docs, structurally the closest analog: wordmark, search, nav, theme
// control, CTA) uses a single small icon button that cycles directly on
// click, confirmed by clicking it and reading
// `document.documentElement.dataset.theme` flip with no menu involved.
// Rendered as inline SVG at currentColor, the same treatment already given
// the GitHub/Discord marks in icons.tsx.
const NEXT: Record<ResolvedTheme, ResolvedTheme> = {
  dark: "light",
  light: "dark",
};

const NEXT_LABEL: Record<ResolvedTheme, string> = {
  dark: "Switch to light theme",
  light: "Switch to dark theme",
};

const CURRENT_LABEL: Record<ResolvedTheme, string> = {
  dark: "Theme: dark",
  light: "Theme: light",
};

export function PdppThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();

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
      aria-label={mounted ? `${CURRENT_LABEL[resolvedTheme]}. ${NEXT_LABEL[resolvedTheme]}.` : "Theme"}
      className={cn(
        // 20px layout box; self-center — nav is items-baseline, icon-only
        // boxes baseline to their bottom edge and ride high vs Search text
        "relative box-border inline-flex size-5 items-center justify-center self-center p-0",
        "cursor-pointer rounded-[2px] border-none bg-transparent",
        "text-ink-soft hover:text-teal",
        "focus-visible:outline-2 focus-visible:outline-teal focus-visible:outline-offset-2",
        "before:absolute before:top-1/2 before:left-1/2",
        "before:h-[max(44px,100%)] before:w-[max(44px,100%)]",
        "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
      )}
      data-testid="theme-toggle"
      onClick={() => setTheme(NEXT[resolvedTheme])}
      title={
        mounted ? `${CURRENT_LABEL[resolvedTheme]} — click to ${NEXT_LABEL[resolvedTheme].toLowerCase()}` : "Theme"
      }
      type="button"
    >
      {mounted ? <ThemeIcon resolved={resolvedTheme} /> : <span aria-hidden className="block size-4" />}
    </button>
  );
}

function ThemeIcon({ resolved }: { resolved: ResolvedTheme }) {
  return resolved === "dark" ? <MoonIcon /> : <SunIcon />;
}

const iconClassName = "block size-4";

function SunIcon() {
  return (
    <svg aria-hidden="true" className={iconClassName} focusable="false" viewBox="0 0 16 16">
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
    <svg aria-hidden="true" className={iconClassName} focusable="false" viewBox="0 0 16 16">
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
