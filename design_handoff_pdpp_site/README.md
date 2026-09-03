# Handoff: pdpp.dev four-intent site + interim Supporter signing

## Overview
Six-view prototype of the new pdpp.dev (Home, Principles, Specification, Build, Participate, Review) plus the spec for an interim Supporter signing backend. This bundle is the input for a Claude Code implementation run in the PDP-Connect/pdpp repo.

## About the design files
The files here are design references created in HTML, not production code. The task is to recreate them in the pdpp repo's existing Next.js environment using its established patterns, tokens and brand package.

- PDPP Site.dc.html — high-fidelity visual source of truth. Open it in a browser; all styling is inline, so every color, size and spacing value can be read directly off the elements. Includes light/dark theming via CSS variables on body[data-theme].
- pdpp-dev-prototype-v3.html — source of truth for structure and copy, carried over verbatim except the copy deltas listed in CLAUDE_CODE_PROMPT.md.
- CLAUDE_CODE_PROMPT.md — the complete build prompt. This is the primary artifact; the two HTML files are its references.

## Fidelity
High-fidelity, with two deliberate placeholders:
- The "pdpp" wordmark is plain text. Use the repo's real logo assets (packages/pdpp-brand/). Never redraw it.
- Fonts in the export load from Google Fonts (Newsreader / IBM Plex Sans / IBM Plex Mono); the implementation must use the repo's own font files and loading.

## Design tokens (light / dark)
Grounds: paper #f4f5f6 / #15181b · paper2 #fcfcfa / #1c2024 · chip #e5e6e7 / #262b30 · wash #e4e7ea / #212b34
Ink: ink #181b1d / #e8eaed · soft #4e5052 / #b3bac1 · faint #67696b / #8a9199
Accent: #295171 / #86aecf · hover #253d53 / #a9c8e4 · on-accent #f4f5f6 / #10171d
Borders: #cccecf / #31373d · subtle #dedfe0 / #262c32
Footer: bg #253d53 / #9cbde0-family (see file) with matching ink ramp
Constant dark panel (code blocks, grant header): #253d53 with #f4f5f6 text in both modes.
Radius: 0-3px only. Shadows: none except the 1px print-offset on terminal blocks and the hairline card borders (box-shadow 0 0 0 1px border).

## Interactions
- SPA-style view switching in the prototype maps to real routes (see prompt).
- Specification nav item has a hover dropdown: "The specification", "Review, until 1 Oct".
- Review banner: slow marquee ticker (~55s loop), whole bar links to /review.
- Hero: three vertically scrolling mono data columns (reuse the existing site component).
- Theme toggle: moon/sun button in nav, persists to localStorage key pdpp-theme.
- Signing form: Individual/Organisation toggle swaps fields, checkboxes and the privacy line; form never submits in the design.
- Card grids draw hairlines per card so odd wraps leave no artifacts.

## Files
- CLAUDE_CODE_PROMPT.md
- PDPP Site.dc.html
- pdpp-dev-prototype-v3.html
