// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the FIRST-PAINT / launch background colors.
//
// These are the sRGB hex equivalents of the `--background` design tokens in
// base.css. They exist because three first-paint surfaces CANNOT read CSS
// custom properties or oklch():
//   1. The anti-FOUC inline <style> guard injected into each app's <head>
//      (paints the html background before external brand CSS loads).
//   2. The web app manifest (manifest.ts) background_color / theme_color.
//   3. viewport.themeColor meta tags.
//
// Keep these in lockstep with the `--background` tokens. If a token changes,
// regenerate the matching hex (e.g. via a culori/oklch→sRGB conversion) and
// update the value here — this is the ONLY place the literal should live.
//
//   LIGHT  ← :root            --background: oklch(0.99 0.002 95)   → #fcfcfa
//   DARK   ← html.dark /       --background: oklch(0.16 0.005 260)  → #0c0d0f
//            html[data-theme="dark"] (and system on a dark OS)
//
// See: packages/pdpp-brand/base.css (:root line ~8, dark block line ~219,
// system @media line ~339).
export const LAUNCH_COLORS = {
  /** :root --background: oklch(0.99 0.002 95) → sRGB */
  light: "#fcfcfa",
  /** html.dark --background: oklch(0.16 0.005 260) → sRGB */
  dark: "#0c0d0f",
} as const;

/**
 * Anti-FOUC first-paint guard CSS. Inject as a BLOCKING inline <style> in
 * <head> so the html background is correct on the very first frame — before
 * the external brand stylesheet loads — for every theme path:
 *
 *   - default / explicit "light"        → light
 *   - explicit "dark"                   → dark
 *   - "system" on a dark OS             → dark (via prefers-color-scheme)
 *   - "system" on a light OS            → light (the default)
 *
 * The selectors deliberately MIRROR base.css's theme resolution so the guard
 * never forces a theme against the user's OS/choice, and so once the real CSS
 * loads the token-driven value takes over without a flash. No transitions here:
 * an animated background would re-introduce the flash this guard removes.
 */
export function launchFoucGuardCss(): string {
  const { light, dark } = LAUNCH_COLORS;
  return [
    `html{background:${light};}`,
    `html[data-theme="dark"]{background:${dark};}`,
    `html[data-theme="light"]{background:${light};}`,
    `@media (prefers-color-scheme: dark){html[data-theme="system"]{background:${dark};}}`,
  ].join("");
}
