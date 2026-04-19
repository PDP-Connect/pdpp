# SLVP Sidebar / Chrome Unification Plan

**Goal:** `/docs` and `/design` share a single canonical sidebar chrome token, step responsively at well-chosen thresholds, and the `/design` "Docs shell" mockup is guaranteed to match the live `/docs` chrome.

**Scope:** chrome alignment only. Not rewriting foundation sections, type scale, or visual language.

**Constraint:** Fumadocs is a framework, not an SLVP reference. We override its defaults where its choices (e.g. reserved TOC grid column at narrow viewports) hurt the experience.

---

## Canonical decisions (locked, do not re-derive)

1. **Sidebar widths — two stepped values:**
   - `1024–1439px`: **240px** (narrow desktop, no TOC)
   - `≥ 1440px`: **280px** (wide desktop, TOC present)
   - Below 1024px: drawer
2. **TOC appears at ≥ 1440px** (not Fumadocs's default of 1280px). Why: at 1280 with sidebar + reserved TOC column, the content column starves.
3. **`/design` has no right-side TOC.** Its left section nav is the TOC. Adding a right TOC is duplicate navigation.
4. **Hero cross-quadrant width is coupled to sidebar width.** Both read from the same token.
5. **The `/design` "Docs shell" mockup must match live `/docs` 1:1.** Both read from the same token.
6. **Hero title clamp must not starve narrow columns.** Retune to `clamp(2rem, 3.5vw, 3rem)` (down from `5vw` ceiling).
7. **Inline `style={{ color: 'var(--*)' }}` is acceptable where used for dynamic state.** Don't consolidate unless trivially replaceable.

---

## Implementation steps

### Step 1 — Add sidebar width token to base.css

**File:** `packages/pdpp-brand/base.css`

Add to `:root` block (find where other layout tokens live, or add a new section):

```css
:root {
  /* Sidebar width — stepped across desktop breakpoints. Below 1024 = drawer. */
  --pdpp-sidebar-width: 240px;
}

@media (min-width: 1440px) {
  :root {
    --pdpp-sidebar-width: 280px;
  }
}
```

### Step 2 — Wire token into Fumadocs docs layout

**File:** `packages/pdpp-brand/docs.css`

Replace the `@media (min-width: 768px) { #nd-docs-layout { --fd-toc-width: 16rem; } }` block so the docs layout reads the token AND overrides the TOC threshold:

```css
@media (min-width: 1024px) {
  #nd-docs-layout {
    --fd-sidebar-width: var(--pdpp-sidebar-width);
  }
}

@media (min-width: 1440px) {
  #nd-docs-layout {
    --fd-toc-width: 16rem;
  }
}

/* Reclaim the reserved TOC grid column below 1440. Fumadocs allocates 256px
   for TOC at xl (1280) but hides the aside, starving the content column. */
@media (max-width: 1439.98px) {
  #nd-docs-layout > div[class*="grid"] {
    grid-template-columns: 0 var(--fd-sidebar-width) 1fr 0 0 !important;
  }
}
```

Note: the `!important` override is a necessary evil because Fumadocs hardcodes the grid template in JSX. Test that selector in dev — may need to match `#nd-docs-layout` child more precisely.

### Step 3 — Fix `/design` sticky section nav to use token

**File:** `apps/web/src/app/design/page.tsx`

- Line 138: replace `w-[200px]` with inline style `style={{ width: 'var(--pdpp-sidebar-width)', ... }}` (keep `hidden md:flex flex-col shrink-0 sticky ...` classes, drop `w-[200px]`)
- Line 86: replace `w-[200px]` the same way on the blank hero quadrant
- Line 1249: replace `w-[200px]` the same way on the docs shell mockup

All three now reference the same token. They step together.

### Step 4 — Fix `/design` hero title clamp

**File:** `apps/web/src/app/design/page.tsx` line 95 + `packages/pdpp-brand/docs.css` line 178

- `/design` hero uses inline `fontSize: '2rem'` — fine, not a clamp, just a fixed size. Leave it.
- `/docs` title clamp at `packages/pdpp-brand/docs.css:178`:
  - **Change** `font-size: clamp(2.2rem, 5vw, 3.2rem);`
  - **To** `font-size: clamp(2rem, 3.5vw, 3rem);`
  - This reduces the max from 51.2px → 48px and the vw coefficient from 5 → 3.5, so titles breathe in narrower columns.

### Step 5 — Verify at four viewports

Resize browser via Playwright and measure at:

1. **1024 × 768** — sidebar 240, no TOC, content col ≥ 780
2. **1280 × 800** — sidebar 240, no TOC, content col ≥ 1000
3. **1440 × 900** — sidebar 280, TOC 256, content col ≥ 840
4. **1536 × 960** — sidebar 280, TOC 256, content col ≥ 920

At each: measure `getBoundingClientRect()` on `#nd-sidebar`, `#nd-page`, and title H1. Title should not wrap more than 2 lines.

Also visit `/design` at the same viewports. Verify:
- Sticky section nav matches sidebar width
- Hero blank quadrant matches sidebar width
- Docs shell mockup's sidebar matches sidebar width
- Nothing overflows or wraps awkwardly

### Step 6 — Cleanup

- Search for any other `w-[200px]` usages: `grep -rn "w-\[200px\]" apps/web/src`
- Search for `--fd-sidebar-width` direct overrides: `grep -rn "fd-sidebar-width" apps/web/src packages`
- Confirm only `base.css` defines `--pdpp-sidebar-width` and only `docs.css` references it for the docs layout

### Step 7 — Document in reference-design-research.md

Append a short "Applied: 2026-04-10 — PDPP sidebar chrome unification" section under the existing sidebar research. Note: two-step breakpoints (240 / 280), TOC threshold shifted to 1440, token-based unification.

---

## Success criteria

1. No hard-coded sidebar width anywhere in the codebase except the token definition
2. `/docs` at 1024px: title wraps ≤ 2 lines
3. `/docs` at 1280px: title wraps ≤ 2 lines, content column ≥ 1000px
4. `/docs` at 1440px: TOC appears, content column ≥ 840px
5. `/design` chrome (hero cross, section nav, docs mockup) all move together at the 1440px threshold
6. Live `/docs` and the `/design` docs shell mockup look identical at every tested viewport
7. No visual regressions in hero or cross-quadrant layout
