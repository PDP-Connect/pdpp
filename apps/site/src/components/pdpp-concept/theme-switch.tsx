// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme/theme-provider.tsx";
import type { ThemeChoice } from "@/components/theme/theme-state.ts";

// Concept-native theme control. Drives the SAME ThemeProvider/cookie as the
// operator-console ThemeToggle (@pdpp/operator-ui) — there is one source of
// truth for theme state — but renders as a three-way segmented control built
// from concept tokens (paper/ink/teal, IBM Plex Mono labels) instead of the
// dense product-UI icon button, which would read as foreign chrome dropped
// into the document register. Explicit light/dark/system options, not a
// cycle button: a document surface favors a legible choice over a hidden
// click-through-3-states affordance.
const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

export function PdppThemeSwitch() {
  const { theme, setTheme } = useTheme();

  // Mirrors ThemeToggle's own mount guard: the server/CSS paints the first
  // frame from the cookie, so rendering the pressed state from React state
  // before hydration risks a flash of the wrong option highlighted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a plain grouping div, not a listbox/menu/toolbar — role="group" is the correct ARIA primitive for "these three buttons are a set", and useAriaPropsSupportedByRole otherwise rejects aria-label on a bare div.
    <div aria-label="Theme" className="pdpp-theme-switch" role="group">
      {OPTIONS.map((option) => {
        const checked = mounted && theme === option.value;
        return (
          <button
            aria-pressed={checked}
            className="pdpp-theme-switch__option"
            data-checked={checked || undefined}
            key={option.value}
            onClick={() => setTheme(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
