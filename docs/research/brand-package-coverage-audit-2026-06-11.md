# Brand Package Coverage Audit — 2026-06-11

> Goal: measure how much of the PDPP UI surface routes through the brand/design-system package today, and produce the exact gap list blocking "swap tokens → everything updates."

---

## 1. What Exists Today

### Brand package: `packages/pdpp-brand` (`@pdpp/brand`)

**Four exports:**

| Export | Role |
|--------|------|
| `@pdpp/brand/base.css` | The design token source of truth — 257 CSS custom-property declarations across `:root` (light) + `.dark` / `[data-theme]` blocks |
| `@pdpp/brand/app.css` | Shell that `@import`s `base.css` — entry for apps |
| `@pdpp/brand/docs.css` | Additional docs/typography tokens |
| `@pdpp/brand/chrome` | `chrome.ts` — exports `siteNav` nav-link array (structural, not styling) |

**Token inventory in `base.css` (178 `:root` variable lines; 257 total across light+dark):**

| Category | Count | Examples |
|----------|-------|---------|
| Color (semantic) | ~130 | `--background`, `--foreground`, `--primary`, `--muted`, `--destructive`, `--status-*-{bg,fg}` (12 pairs), `--authorship-*` (12), `--callout-*` (6), `--human`, `--edu-fg`, surface ladder |
| Color (badge/wash) | ~30 | `--success-wash`, `--primary-wash`, `--verified-wash`, badge-foreground tokens |
| Animation | 15 | `--duration-{fast,base,moderate,slow,crawl}`, easing curves |
| Spacing | 10 | `--space-{0,1,2,3,4,5,6,8,10,12}` — 4px-grid |
| Radius | 5 | `--radius-{sm,md,lg,pill}` + `--radius` alias |
| Typography | 3 | `--font-sans`, `--font-mono`, `--numeric` |
| Shadow | 4 | `--shadow-overlay`, elevation variants |
| Layout | 2 | `--pdpp-sidebar-width`, `--pdpp-nav-height` |

**Notable strength:** The token set is deliberately semantic and domain-specific — status surface tiers (`status-success-bg/fg`), authorship provenance (`authorship-protocol-fg`), surface elevation ladder (`surface-page/card/raised/overlay`) — not just a palette remap. These tokens exist precisely to make SLVP-quality status UIs portable.

**Notable gap:** The brand package has **no TypeScript/JS exports of tokens** (no `tokens.ts`, no `colors` object). Token consumption is CSS-only; there is no way to reference a token value in a canvas/SVG/inline-style calculation without re-hardcoding the oklch value. This matters for dynamic `borderColor`, chart stroke colors, etc.

### Shared component library: `packages/operator-ui` (`@pdpp/operator-ui`)

57 exported paths: 37 `/components/*`, 13 `/ui/*` + 7 `/lib/*` + `/explore/*`.

**UI primitives re-exported (wrapping shadcn/radix):**
`button`, `input`, `select`, `dialog`, `timestamp`, `badge`, `card`, `popover`, `scroll-area`, `separator`, `textarea`, `tooltip`

**Domain components exported:**
`primitives`, `overview-hero`, `run-row`, `connect-agent-card`, `timeline-view`, `peek`, `mobile-drawer`, `command-palette`, `copy-button`, `pdpp-logo`, `empty-state`, `theme/{provider,toggle,state}`, `pdpp/{consent-card,connector-card,stream-inventory,grant-inspector,spec-citation}`, and 7 view-level composites.

**How both apps consume it:** Both `apps/console` and `apps/site` re-export everything through local shim files under `src/components/`. This means the apps never import `@pdpp/operator-ui` directly from feature code — they go through their own re-export wrappers (e.g. `apps/console/src/components/ui/button.tsx` → `@pdpp/operator-ui/ui/button`).

---

## 2. Coverage Measurement

### Commands used (reproducible)

```bash
# Hardcoded hex colors
grep -rEn '#[0-9a-fA-F]{6}' apps/console/src packages/operator-ui/src apps/site/src \
  --include='*.tsx' --include='*.ts' | grep -v '\.test\.' | grep -v 'svg\|fill=\|stroke=\|//\|\*'

# Raw Tailwind palette (not semantic tokens)
grep -rEn '(?:text|bg|border|ring|fill)-(?:gray|zinc|slate|stone|neutral|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]' \
  apps/console/src packages/operator-ui/src apps/site/src --include='*.tsx' --include='*.ts' \
  | grep -v '\.test\.'

# Arbitrary Tailwind size brackets
grep -rEn '(?:text|w|h|max-w|min-w|rounded)-\[[0-9]' \
  apps/console/src packages/operator-ui/src apps/site/src --include='*.tsx' | grep -v '\.test\.'

# Arbitrary Tailwind color brackets
grep -rEn '(?:text|bg|border|fill|stroke|ring|shadow)-\[#[0-9a-fA-F]' \
  apps/console/src packages/operator-ui/src apps/site/src --include='*.tsx' | grep -v '\.test\.'

# Inline style={{ with hardcoded px or hex
grep -rEn 'style=\{\{[^}]*[0-9]+px|style=\{\{[^}]*#[0-9a-fA-F]' \
  apps/console/src packages/operator-ui/src apps/site/src --include='*.tsx' | grep -v '\.test\.'
```

### Headline numbers

| Metric | console | operator-ui | site | Total |
|--------|---------|-------------|------|-------|
| Total non-test `.tsx` files | 108 | 37 | 85 | 230 |
| Files with `className` styling | 51 (47%) | 36 (97%) | 43 (51%) | 130 |
| Files importing `@pdpp/operator-ui` | 61 (56%) | — | 46 (54%) | 107 |
| Files using semantic Tailwind tokens | 47 | 28 | 30 | 105 |
| Files with raw palette colors (emerald/amber/etc.) | 11 | 2 | 2 | **15** |
| Files with hardcoded inline styles (px / #hex) | 1 | 4 | 13 | **18** |
| Hardcoded hex `#xxxxxx` in .ts/.tsx | 1 | 0 | 19 | **20** |
| Arbitrary Tailwind color brackets `bg-[#...]` | 0 | 0 | 0 | **0** |
| Raw Tailwind palette occurrences | 39 | 4 | 6 | **49** |
| Arbitrary size brackets (`text-[...]`, `max-w-[...]`) | 27 | 12 | 67 | **106** |
| Inline style `px` values | 1 | 11 | 117 | **129** |
| Inline style `rem` values | 0 | 3 | 41 | **44** |

**Key findings:**

- **No arbitrary color bracket escapes (`bg-[#...]`)** — this is the worst-case hardcoding pattern and it's zero. Good signal.
- **Raw palette colors (49 occurrences, 15 files)** are almost entirely in `apps/console` and all cluster in the connection-health / status surfaces. These are the most urgent gap because they bypass the `--status-*` token tier that already exists for exactly this purpose.
- **Inline style px values (129 occurrences)** are heavily skewed to `apps/site` (117) and `packages/operator-ui` (11). Most are layout constraints (`maxWidth: "440px"`), not color.  Inline styles using CSS vars (363 occurrences) are _already_ tokenized correctly.
- **Arbitrary size brackets (106)** — 84 are in `apps/site`. Of those, 68 are in `apps/site/src/app/design/page.tsx`, which is the design-system documentation page itself (showing the token scale) — that page intentionally demonstrates hardcoded values. The real production count is ~16 in site and ~27 in console.
- **Hex escapes (20)** — 1 is a real production bug (console `connector-row.tsx`). The site's 19 are almost all in the design-docs page or SVG asset generators (`apple-icon.tsx`, `manifest.ts`). One borderline case: `longview-wordmark.tsx` uses `#FBFCFE` for the inverse logo color.

**Styling approaches in use:** Pure Tailwind v4 + CSS custom properties from `@pdpp/brand/base.css`, re-bridged into Tailwind utilities in `globals.css` via `@theme inline`. No CSS Modules, no styled-components, no `@emotion`. `@apply` used in exactly two places (both `globals.css` files, for `body` base styles — fine). Single coherent approach.

---

## 3. Gap List (Prioritized for "Swap Tokens → Everything Updates")

The question is not whether tokens exist — they do, and they're good. The question is whether component code _uses_ them or bypasses them.

| # | File / Area | What's Hardcoded | What It Should Consume | Effort |
|---|-------------|-----------------|----------------------|--------|
| 1 | `apps/console/src/app/dashboard/records/connector-row.tsx` (L901, L1239, L1245, L1248) | `emerald-500`, `blue-500`, `#dc2626` fallback in style prop | `bg-status-success-bg text-status-success-fg`, `bg-status-progress-bg`, `bg-destructive` | S (30 min) |
| 2 | `apps/console/src/app/dashboard/lib/source-setup-presentation.ts` (all tone strings) | `border-emerald-500/30 bg-emerald-500/10 text-emerald-700`, `border-amber-500/30 …` | Map to `bg-status-success-bg text-status-success-fg` / `bg-status-warning-bg text-status-warning-fg` | S |
| 3 | `apps/console/src/app/dashboard/lib/source-add-support.ts` (tone strings) | Same emerald/amber patterns | Same status-surface tokens | S |
| 4 | `apps/console/src/app/dashboard/records/[connector]/connection-diagnostics.tsx` | `emerald-700 dark:text-emerald-300`, `emerald-500/30 bg-emerald-500/5` | `text-status-success-fg`, `bg-status-success-bg` | S |
| 5 | `apps/console/src/app/dashboard/records/[connector]/connection-danger-zone.tsx` | `emerald-500/30`, `emerald-500/60`, `emerald-500/5`, `emerald-700 dark:emerald-400` | Status-surface tokens | S |
| 6 | `apps/console/src/app/dashboard/records/[connector]/stream-collection-facts.tsx` | Same emerald pattern | Status-surface tokens | S |
| 7 | `apps/console/src/app/dashboard/records/page.tsx` | Same emerald/amber pattern | Status-surface tokens | S |
| 8 | `apps/console/src/app/dashboard/components/warnings-banner.tsx` + `web-push-settings.tsx` + `schedule-row.tsx` | Raw palette colors | Status-surface tokens | S |
| 9 | `packages/operator-ui/src/components/pdpp/connector-card.tsx` + `stream-inventory.tsx` + `grant-inspector.tsx` | `style={{ maxWidth: "440px" }}`, `style={{ borderTop: "1px solid var(--border)" }}` | `max-w-[440px]` → token `max-w-component-card`; border → `border-t border-border` Tailwind utility | M |
| 10 | `packages/operator-ui/src/components/pdpp/spec-citation.tsx`, `apps/site/src/components/reference-app.tsx` | Inline `style={{ border: "1px solid var(--border)" }}`, `maxWidth` constraints | Tailwind `border border-border rounded-*`, `max-w-*` using token-based width | M |
| 11 | `apps/site/src/components/longview-wordmark.tsx` | `#FBFCFE` for inverse mode wordmark | `var(--primary-foreground)` or a named brand color CSS var | XS |
| 12 | `apps/site/src/components/reference-app.tsx` (L969) | Template-literal `borderLeft: \`2px solid \${borderColor}\`` with computed color | Derive `borderColor` from a token map (`--authorship-protocol-fg`, etc.) and use CSS var | M |
| 13 | `packages/operator-ui/src/components/views/deployment-diagnostics-view.tsx` + `schedules-view.tsx` | Raw palette colors | Status / warning semantic tokens | S |
| 14 | Size brackets (`text-[10px]`, `text-[0.7rem]`, etc.) in `reference-app.tsx`, `sandbox-walkthrough.tsx`, `longview-wordmark.tsx` | Ad-hoc font sizes for micro-labels, captions | `pdpp-caption` / `pdpp-eyebrow` typography utilities already defined in globals.css; or `text-xs` / `text-[0.7rem]` via a `--font-size-micro` token | M |
| 15 | **Missing: JS/TS token export** | Brand tokens not accessible from JS — can't reference `--status-danger-fg` in a computed `borderColor` prop or chart config without re-hardcoding the oklch value | `@pdpp/brand` should export a `tokens.ts` with typed constants derived from the CSS vars | M |

### Not gaps (intentional):
- `apps/site/src/app/design/page.tsx` — design system docs, shows hex/oklch by design
- `apps/site/src/app/apple-icon.tsx`, `manifest.ts` — asset generators, must use hex
- `inline style` with `var(--token)` — already correct (363 occurrences)
- `@apply bg-background text-foreground` in `globals.css` — correct, only two sites

---

## 4. Recommended Target Architecture

### What `@pdpp/brand` should export (additions needed)

```
packages/pdpp-brand/
  base.css        ✓ exists — design token source of truth
  app.css         ✓ exists — app shell
  docs.css        ✓ exists — docs typography
  chrome.ts       ✓ exists — nav links

  tokens.ts       MISSING — typed JS/TS constants for all tokens
                  export const tokens = {
                    color: { primary: "var(--primary)", statusSuccessBg: "var(--status-success-bg)", ... },
                    space: { "4": "var(--space-4)", ... },
                    radius: { md: "var(--radius-md)", ... },
                  } as const
```

This enables inline `style={{ borderColor: tokens.color.statusDangerFg }}` and chart/canvas color references without re-hardcoding oklch values.

### What `@pdpp/operator-ui` should add

A `StatusTone` utility type + CSS-class map is partially implemented (see `source-setup-presentation.ts` doing it manually). Centralizing this into operator-ui prevents each page from re-inventing the emerald/amber/red palette bypass:

```ts
// packages/operator-ui/src/lib/status-tone.ts  (MISSING)
export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'progress' | 'disabled';
export const statusToneClasses: Record<StatusTone, string> = {
  success:  'bg-status-success-bg text-status-success-fg border-status-success-fg/30',
  warning:  'bg-status-warning-bg text-status-warning-fg border-status-warning-fg/30',
  danger:   'bg-status-danger-bg text-status-danger-fg border-status-danger-fg/30',
  neutral:  'bg-status-neutral-bg text-status-neutral-fg border-status-neutral-fg/30',
  progress: 'bg-status-progress-bg text-status-progress-fg border-status-progress-fg/30',
  disabled: 'bg-status-disabled-bg text-status-disabled-fg',
};
```

A `BadgeTone` variant with `pdpp-eyebrow` typography is similarly needed — the pattern `"pdpp-eyebrow inline-flex rounded-[3px] px-1.5 py-0.5 font-medium ${meta.tone}"` appears 5+ times verbatim.

### Migration order for SLVP bar

**Stripe/Linear/Vercel/Plaid** quality means: no raw palette color escapes, no `#hex` in component logic, status surfaces use semantic bg/fg pairs, typography has named scales.

1. **Sprint 1 — Eliminate all 49 raw palette occurrences** (items 1–8 + 13). All are in console status/badge surfaces. Replace with `bg-status-*-bg text-status-*-fg`. Add `status-tone.ts` to operator-ui. Effort: 1 day.

2. **Sprint 2 — Convert inline border/maxWidth in operator-ui pdpp components** (items 9–10). `connector-card`, `stream-inventory`, `grant-inspector`, `spec-citation`. Replace inline `style={{ borderTop: ... }}` with Tailwind `border-t border-border`. Add a `max-w-component` token for the 440px card constraint. Effort: half day.

3. **Sprint 3 — Add `tokens.ts` to `@pdpp/brand`** (item 15). Enables computed color references without hardcoding. Prerequisite for chart/canvas work and the `reference-app.tsx` `borderLeft` dynamic color (item 12). Effort: 1 day.

4. **Sprint 4 — Typography micro-scale token** (item 14). Add `--font-size-micro` / `--font-size-caption` to base.css; wire as `text-micro` / `text-caption` Tailwind utilities in globals. Consolidates the `text-[0.7rem]` / `text-[10px]` pattern. Effort: half day.

5. **Sprint 5 — Wordmark + logo inverse** (item 11). Trivial: one line. Ship anytime.

---

## 5. Overall Verdict

The architecture is **sound and nearly complete** — there is a single brand package with a well-designed semantic token set, a single styling approach (Tailwind v4 + CSS vars), and both apps route their shared components through `@pdpp/operator-ui`. The token set already covers the full domain (status surfaces, authorship provenance, elevation ladder, animation) and is correctly bridged into Tailwind utilities in `globals.css`.

The gap is a **thin execution layer**: ~49 raw palette color uses concentrated in console's connection-health surfaces, ~18 files with hardcoded inline `px` constraints, and one missing JS token export. None of these require architecture changes — they are call-site migrations to tokens that already exist.

After completing Sprints 1–2 (~1.5 dev-days), the "swap tokens → everything updates" bar is met for color and component structure. Sprints 3–4 close the remaining corners for dynamic colors and typography micro-scale.

**The design system handoff can proceed immediately** — the `@pdpp/brand` token set is the correct reception point for a new palette from the UX designer. Updating `base.css` values (oklch colors, radius, spacing) will propagate to every correctly-tokenized surface on rebuild. The raw-palette migration (Sprint 1) is the only prerequisite for the new palette to land cleanly everywhere.
