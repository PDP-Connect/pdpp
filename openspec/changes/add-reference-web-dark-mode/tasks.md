# Tasks — add-reference-web-dark-mode

## 1. Brand tokens

- [x] 1.1 Add `--surface-tint` light/dark token in `packages/pdpp-brand/base.css`
  and replace literal `white` keyword in `color-mix(...)` expressions and the
  hardcoded `oklch(1 0 0)` in the body gradient.
- [x] 1.2 Add `html.dark { ... }` override block in `packages/pdpp-brand/base.css`
  with full dark token palette (background, foreground, card, popover, primary,
  secondary, muted, accent, destructive, border, input, ring, success, warning,
  edu-fg, success-wash, success-wash-strong, primary-wash, verified-wash,
  warning-wash, human, human-wash, surface-tint).
- [x] 1.3 Update `packages/pdpp-brand/docs.css` to use `--surface-tint` rather
  than literal `white` in the `color-mix` mixers it uses for sidebar tint, prose
  body color, prose code background, and table header.
- [x] 1.4 Override scrollbar thumb color under `html.dark` so the
  `oklch(0 0 0 / …)` light-mode thumb does not vanish on dark.

## 2. Theme runtime

- [x] 2.1 Add inline pre-hydration theme script in
  `apps/web/src/app/layout.tsx` (head, dangerouslySetInnerHTML) that reads
  `localStorage` + `prefers-color-scheme` and applies `html.dark`,
  `data-theme`, and `style.colorScheme` before paint.
- [x] 2.2 Add `apps/web/src/components/theme/theme-provider.tsx` (client) that
  exposes `{ theme, resolvedTheme, setTheme }` via context, persists to
  `localStorage`, and listens for system preference changes when in `"system"`
  mode.
- [x] 2.3 Add `apps/web/src/components/theme/theme-toggle.tsx` (client) — a
  small icon button cycling light → dark → system, with accessible labels.

## 3. Mount points

- [x] 3.1 Wrap `RootProvider`'s children with `ThemeProvider` in
  `apps/web/src/app/layout.tsx`.
- [x] 3.2 Place `<ThemeToggle />` in the dashboard `Topbar`
  (`apps/web/src/app/dashboard/components/shell.tsx`).
- [x] 3.3 Place `<ThemeToggle />` in the public `SiteHeader`
  (`apps/web/src/components/site-header.tsx`).

## 4. Surface polish

- [x] 4.1 Audit dashboard surfaces (records, runs, deployment, search,
  overview) for any hardcoded color utilities that would regress in dark mode.
  Convert to semantic tokens or add `dark:` variants where unavoidable.
- [x] 4.2 Verify shadcn primitives (`button`, `badge`, `card`, `dialog`,
  `popover`, `input`, `select`, `tooltip`) render correctly in dark mode under
  the new tokens — they already use `dark:` variants in places, so most just
  needs the underlying tokens to be right.

## 5. Validation

- [x] 5.1 `pnpm --dir apps/web run types:check`
- [x] 5.2 `pnpm --dir apps/web run check`
- [x] 5.3 `pnpm --dir apps/web run build`
- [x] 5.4 `openspec validate add-reference-web-dark-mode --strict`
- [x] 5.5 `openspec validate --all --strict`

## 6. Deferred

- [ ] 6.1 Marketing `/` hero polish in dark mode (illustrations/washes use
  light-mode-baked gradients; legible but not a deliberate dark composition).
- [ ] 6.2 Dedicated docs toggle inside Fumadocs chrome — currently controlled
  by the dashboard/site header toggle via the shared `html.dark` class.
- [ ] 6.3 `/palette` and `/design` reference pages beyond falling out of the
  new tokens.

## Acceptance checks

- Booting the dashboard with the OS in dark mode and no stored preference
  renders dark on first paint with no flash.
- Toggling the theme changes both the dashboard chrome and the embedded
  `/docs` and `/reference` surfaces in the same window.
- Reload preserves the explicit choice; clearing storage falls back to
  system preference.
- Status badges (online/offline, success/destructive) remain identifiable
  at a glance in dark mode.
