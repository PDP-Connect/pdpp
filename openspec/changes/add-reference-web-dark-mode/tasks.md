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

## Theme flicker regression closeout

- [x] T.1 Restore the `<head>`-mounted raw `<script dangerouslySetInnerHTML>`
  resolver in `apps/web/src/components/theme/theme-script.tsx`. The previous
  `next/script` with `strategy="beforeInteractive"` shape did not block paint
  in App Router, producing a dark/light/dark flicker on first load. Document
  the requirement inline so it does not regress.
- [x] T.2 Add `apps/web/src/components/theme/theme-script.test.ts` to assert
  (a) the resolver is a raw `<script>` (no `next/script` import), (b) it is
  rendered inside `<head>` of the root layout before `<body>`, (c) it
  applies the `dark` class and reads `pdpp-theme` localStorage, (d) the
  IIFE is try/catch-wrapped so a failure cannot block paint, and
  (e) `RootProvider theme={{ enabled: false }}` remains in place so
  Fumadocs does not duplicate the toggle.

## 6. Deferred

- [ ] 6.1 Marketing `/` hero polish in dark mode (illustrations/washes use
  light-mode-baked gradients; legible but not a deliberate dark composition).
  Closeout pass: the hero gradients already use `--human-wash` /
  `--primary-wash`, which adapt; the remaining "baked" feel is the literal
  `oklch(...)` washes inside `ProtocolSection` and `DefaultReferenceHero` in
  `reference-app.tsx`. Those are intentionally low-alpha and read on dark, so
  they are not regressions but also not a deliberate dark composition.
  Leaving unchecked until a designer takes a deliberate dark-mode hero pass.
- [ ] 6.2 Dedicated docs toggle inside Fumadocs chrome — currently controlled
  by the dashboard/site header toggle via the shared `html.dark` class.
  Blocker: Fumadocs' built-in `themeSwitch` (`fumadocs-ui/layouts/shared/slots/theme-switch`)
  drives `next-themes`'s `useTheme`, which writes its own `localStorage` key
  and class. Our app intentionally uses a custom `ThemeProvider` keyed off
  `THEME_KEY` (see `apps/web/src/components/theme/theme-provider.tsx`) to
  avoid the `next-themes` dependency. Enabling Fumadocs' switch would diverge
  storage and re-introduce a hydration-flash class race. Resolution requires
  either (a) installing `next-themes` and migrating our provider onto it, or
  (b) authoring a Fumadocs slot that delegates to our provider. Both are
  out of scope for closeout polish. The header `<ThemeToggle />` continues
  to control `/docs` via the shared `html.dark` class.
- [x] 6.3 `/palette` and `/design` reference pages beyond falling out of the
  new tokens. Replaced every `color-mix(..., white)` literal in
  `apps/web/src/app/design/page.tsx` with `var(--surface-tint)` so the
  established mixer pattern adapts in dark mode. `/palette` is a
  contributor-only research artifact whose explicit `white` literals are the
  experiment itself (testing colors against a white background);
  intentionally left alone with that scoping.

## Acceptance checks

- Booting the dashboard with the OS in dark mode and no stored preference
  renders dark on first paint with no flash.
- Toggling the theme changes both the dashboard chrome and the embedded
  `/docs` and `/reference` surfaces in the same window.
- Reload preserves the explicit choice; clearing storage falls back to
  system preference.
- Status badges (online/offline, success/destructive) remain identifiable
  at a glance in dark mode.
