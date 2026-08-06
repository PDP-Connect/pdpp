// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for manifest and viewport launch colors.
//
// These are the sRGB hex equivalents of the `--background` design tokens in
// primitive.css. They exist because browser metadata cannot read CSS
// custom properties or oklch():
//   1. The web app manifest (manifest.ts) background_color / theme_color.
//   2. viewport.themeColor meta tags.
//
// Keep these in lockstep with the `--background` tokens. If a token changes,
// regenerate the matching hex (e.g. via a culori/oklch→sRGB conversion) and
// update the value here — this is the ONLY place the literal should live.
//
//   LIGHT  ← :root            --background: oklch(0.99 0.002 95)   → #fcfcfa
//   DARK   ← [data-theme="dark"] --background: oklch(0.16 0.005 260) → #0c0d0f
export const LAUNCH_COLORS = {
  /** :root --background: oklch(0.99 0.002 95) → sRGB */
  light: "#fcfcfa",
  /** [data-theme="dark"] --background: oklch(0.16 0.005 260) → sRGB */
  dark: "#0c0d0f",
} as const;
