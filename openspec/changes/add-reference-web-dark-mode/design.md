# Design — add-reference-web-dark-mode

## Goals

- A dashboard dark theme that an operator can stare at for hours.
- Preserve PDPP's existing visual language: cool blue primary, warm "human"
  accent, success/warning/destructive semantics. Do not produce the generic
  saturated-purple-on-pure-black look.
- Avoid hydration flash in App Router on first paint.
- Make the toggle reachable from anywhere in the live operator surface.

## Where the theme is decided

The body of the page is owned by Next App Router. We do not use
`next-themes`; the theme machinery is small enough to write directly and we
already have shadcn's `@custom-variant dark (&:is(.dark *))` wired up.

Resolution order on a fresh session, executed *before* React hydration via an
inline script in `<head>`:

1. `localStorage.getItem("pdpp-theme")` if it equals `"light"` or `"dark"`.
2. Otherwise (`"system"` or absent) read
   `window.matchMedia("(prefers-color-scheme: dark)").matches`.
3. Apply `document.documentElement.classList.toggle("dark", isDark)` and set
   `data-theme="light|dark"` and `style.colorScheme` so native form controls
   match.

The inline script is the only place that runs before hydration. The
`ThemeProvider` reads the same storage key to seed React state and emits
a custom event when the user flips the toggle so other tabs can sync via
the storage event listener.

`suppressHydrationWarning` is already present on `<html>`; we keep it.

## Token shape

The brand exposes semantic tokens (`--background`, `--foreground`, `--card`,
`--muted`, `--primary`, `--border`, `--success`, etc.). Dark mode is added by
overriding the same names under `html.dark` in `packages/pdpp-brand/base.css`.

The light palette stays as-is. Dark values are picked to:

- Background `oklch(0.16 0.005 260)` — near-neutral charcoal with the faintest
  cool tilt to harmonize with the brand blue, not pure black.
- Foreground `oklch(0.96 0.005 260)` — soft off-white; not 1.0 to keep glyph
  edges from buzzing.
- Card / popover slightly elevated (`oklch(0.20 …)`) so panels read above the
  page surface, with `border` close enough to background to feel structural,
  not boxy.
- Primary blue lifts to `oklch(0.72 0.16 253.7)` — stays clearly the same
  brand hue but readable against dark.
- Success/warning/destructive are lifted to ~`L 0.72` so the badge dots remain
  identifiable. Status uses both hue and a leading icon/dot pattern so users
  who can't disambiguate hue (or who have monitors with poor color rendering
  at low luminance) still get the signal.

The wash variants (`--success-wash`, `--primary-wash`, `--human-wash`) keep the
same percentage alpha; OKLCH carries the new lightness through automatically.

## Brand CSS hardcodes

Several rules in `packages/pdpp-brand/base.css` and `docs.css` mix tokens with a
literal `white`. In light mode this is fine. In dark mode it pulls surfaces
back toward white and breaks contrast. We introduce a single
`--surface-tint` token (white in light, near-black in dark) and replace the
literal `white` keyword in those `color-mix` expressions, plus the explicit
`oklch(1 0 0)` in the body gradient.

## Status colors and accessibility

- Existing status dots/pills already pair color with shape (icons, dot before
  the label). Where a row was color-only we add a leading dot so dark-mode
  contrast does not regress affordance.
- `bg-yellow-200 text-black dark:bg-yellow-700 dark:text-white` already
  exists on the search highlight; we keep it.

## Toggle UI

Cycling tri-state `light → dark → system → light` from a single icon button.
The icon swaps with the resolved theme; `aria-label` reflects the current
state and the next state in tooltip text. The button lives:

- in the dashboard `Topbar` (right-aligned next to the command palette
  trigger);
- in `SiteHeader` (rightmost).

It is not added to `/docs` chrome in this tranche — Fumadocs' own theme
machinery is disabled (`theme={{ enabled: false }}`) and the docs surface
inherits the same `html.dark` class, so the dashboard toggle controls the
docs surface implicitly. A dedicated docs toggle is documented as a follow-up.

## Out of scope

- Theming the marketing `/` hero illustrations (they currently use baked
  light-mode washes; they degrade gracefully in dark mode but a polished
  dark-mode variant is followup work).
- Theming `/palette` and `/design` reference pages beyond what falls out of
  the new tokens — those pages display swatches whose meaning is light-mode-
  specific.
- Per-route persisted preference. One choice per browser is enough.

## Acceptance checks

- `pnpm --dir apps/web run types:check`
- `pnpm --dir apps/web run check`
- `pnpm --dir apps/web run build`
- `openspec validate add-reference-web-dark-mode --strict`
- `openspec validate --all --strict`
- Visual smoke: dashboard overview, records, runs, deployment, search render
  legibly in dark mode; no flash on first paint when the OS prefers dark.
