// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useTheme } from "@pdpp/operator-ui/components/theme/theme-provider";
import { Moon, Sun } from "lucide-react";
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
        "hit-area-overlay box-border inline-flex size-5 items-center justify-center self-center p-0",
        "cursor-pointer rounded-[2px] border-none bg-transparent",
        "text-muted-foreground hover:text-primary",
        "focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
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
  const iconClassName = "size-4";
  return resolved === "dark" ? (
    <Moon aria-hidden className={iconClassName} />
  ) : (
    <Sun aria-hidden className={iconClassName} />
  );
}
