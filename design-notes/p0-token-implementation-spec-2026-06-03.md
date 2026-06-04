# P0 Token Implementation Spec (exact decisions)

Status: implementing
Owner: design/ui-elevation-and-action-parity lane
Source: console-redesign-prior-art-2026-06-03.md (§5 P0)

The orchestrator has ALREADY added to `packages/pdpp-brand/base.css`:
- `:root` (light): radius scale (`--radius-sm/md/lg/pill`, `--radius` aliased to md), spacing scale (`--space-0..12`), surface ladder (`--surface-page/card/raised/overlay`, `--border-strong`, `--shadow-overlay`), `--numeric`.
- dark `:is(html.dark, html[data-theme="dark"])` block: surface-ladder charcoal steps, `--edu-fg` → `oklch(0.78 0.05 250)`, `--human` → `oklch(0.78 0.10 65)` (+ wash).

## Remaining P0 work (exact)

### 1. Mirror dark tokens into the system block
The `@media (prefers-color-scheme: dark) html[data-theme="system"]` block (≈ line 160+ of base.css) is a DUPLICATE of the `.dark` block. Apply the SAME edits there verbatim: edu-fg `oklch(0.78 0.05 250)`, human `oklch(0.78 0.10 65)` + human-wash `/ 0.10`, and the full surface ladder (`--surface-page: oklch(0.16 0.005 260)`, `--surface-card: oklch(0.20 0.006 260)`, `--surface-raised: oklch(0.235 0.006 260)`, `--surface-overlay: oklch(0.235 0.006 260)`, `--border-strong: oklch(0.34 0.006 260)`, `--shadow-overlay: 0 10px 28px -10px oklch(0 0 0 / 0.55), 0 3px 8px -3px oklch(0 0 0 / 0.40)`). Keep both blocks token-identical.

### 2. Remove decorative gradients on the operator surface
In base.css:
- `body { background: ... }` — REMOVE the `radial-gradient(circle at top left, ...)` corner wash and the `linear-gradient(180deg, var(--surface-tint) ...)` lift. Replace with a flat `background: var(--background);`. (The marketing wash belongs on the public site, not the operator console.)
- `[data-surface="protocol"]` and `[data-surface="human"]` — REMOVE the `background-image: linear-gradient(...)` fills. Keep the 2px left-border marker (`border-left: 2px solid var(--primary)` / `var(--human)`) + the other three 1px borders, and set a single flat tint at card level via `background-color: var(--card)` PLUS a subtle flat wash: protocol `background-color: color-mix(in oklab, var(--card) 94%, var(--primary))`; human `color-mix(in oklab, var(--card) 94%, var(--human))`. (One flat step, no gradient.)

### 3. Replace resting drop-shadows with the ladder
- `[data-surface="protocol"]` and `[data-surface="human"]`: REMOVE the `box-shadow: 0 1px 2px... , 0 1px 3px...`. Resting cards get elevation from border+tint only.
- Audit base.css + globals.css for other RESTING `box-shadow` on non-floating surfaces and remove them; KEEP shadows only on genuinely floating layers (the `.pdpp-stream-*` control buttons/labels/toast bubbles in globals.css are floating overlays — leave those, or migrate them to `var(--shadow-overlay)` if trivial, but do NOT break them).

### 4. Numeric treatment (tabular figures) — systematic
- In globals.css, add a base rule so data aligns: a `.pdpp-num` utility AND a table-scoped default. Add to the `@layer base` or a new rule:
  `.pdpp-num, [data-numeric], table { font-variant-numeric: var(--numeric); }`
  and ensure `td`, `th` inherit. Do NOT force tabular-nums on ALL text globally (only data/tables/the utility), to avoid changing prose rendering.
- Expose a Tailwind-friendly hook if needed, but the `.pdpp-num` class + table rule is sufficient.

### 5. Radius tokens reach Tailwind
- `apps/console/src/app/globals.css` `@theme inline` currently maps colors + type but NOT radius. Add: `--radius-sm: var(--radius-sm); --radius-md: var(--radius-md); --radius-lg: var(--radius-lg);` so `rounded-sm/md/lg` Tailwind utilities resolve to the brand scale, and the existing `var(--radius-md)` references in button.tsx resolve correctly. Verify Tailwind v4 `@theme` radius naming (`--radius-*` → `rounded-*`).
- Optionally map spacing: Tailwind v4 already provides the 4px scale; do NOT remap spacing unless a token reference breaks. The spacing tokens in base.css are for direct var() use in component CSS.

## Verification (MANDATORY — do all)
- `pnpm --dir apps/console run types:check` clean.
- `ultracite check` (or biome) clean on touched files (base.css, globals.css).
- The dev console at :3500 must still build/HMR — fetch http://localhost:3500/owner/login → 200 after changes.
- Grep base.css for `radial-gradient` and resting `box-shadow` on `[data-surface]` to confirm removal.
- Confirm the three theme blocks (`:root`, `.dark`, system) define the SAME set of new tokens (no token defined in one but missing in another).

Do NOT touch component .tsx files in this task (that's P1/P3). This is tokens + brand CSS + the Tailwind theme bridge ONLY. Do NOT commit.
