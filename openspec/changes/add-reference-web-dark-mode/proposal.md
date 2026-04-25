## Why

The reference web app is light-only. The owner uses the dashboard as a sustained operator surface (records, runs, deployment diagnostics, search), and prolonged light-mode use is uncomfortable. The brand and shadcn primitives already encode every color through semantic CSS variables (`--background`, `--foreground`, `--muted`, `--border`, `--primary`, `--success`, `--destructive`, etc.) and Tailwind 4 already exposes a `dark` variant via `@custom-variant dark (&:is(.dark *))`. The missing piece is an actual `.dark` token set, a flicker-free toggle, and a few legacy `color-mix(... white)` mixes in the brand CSS that bake the page background being white.

## What Changes

- Define a dark-mode token set in `packages/pdpp-brand/base.css` under `html.dark` that preserves the brand's semantic structure (cool primary blue, human warm accent, success/warning/destructive at accessible contrast on dark surfaces) rather than the generic purple-on-black look.
- Replace hardcoded `white` mixers in brand CSS (body gradient, sidebar tint, table header, prose mute) with a `--surface-tint` token that flips to a dark equivalent so docs and dashboard surfaces remain coherent in dark mode.
- Add an inline pre-hydration theme script in `apps/web/src/app/layout.tsx` that resolves `localStorage('pdpp-theme')` or the `prefers-color-scheme` media query and sets `html.dark` before paint to avoid flash.
- Add a small `ThemeProvider` + `ThemeToggle` client component pair under `apps/web/src/components/theme/` that exposes light / dark / system, persists explicit choices, and tracks `prefers-color-scheme` when in system mode.
- Mount the toggle in the dashboard topbar (`apps/web/src/app/dashboard/components/shell.tsx`) and in the public site header (`apps/web/src/components/site-header.tsx`).
- Adjust dashboard surfaces that currently rely on `dark:` Tailwind variants (search highlight, deployment page) to keep contrast in dark and verify that the existing `dark:` branches in shadcn primitives (`button`, `badge`) match the new token set.
- Document the dashboard-first scope and any deferred docs/marketing polish in `tasks.md`.

## Capabilities

### Modified Capabilities

- `reference-surface-topology` — the dashboard and public surfaces SHALL support an explicit dark theme alongside the existing light theme, and the choice SHALL be operator-controllable.

## Impact

- `packages/pdpp-brand/base.css`
- `packages/pdpp-brand/docs.css`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/theme/*` (new)
- `apps/web/src/components/site-header.tsx`
- `apps/web/src/app/dashboard/components/shell.tsx`
- A small set of dashboard pages that already used `dark:` utilities ad-hoc.
