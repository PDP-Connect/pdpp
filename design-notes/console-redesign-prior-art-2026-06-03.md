# PDPP Operator Console — Design Point of View & Prior-Art Research

**Date:** 2026-06-03
**Author:** Design prior-art research pass
**Scope:** Elevate the existing `pdpp-brand` from "programmer-made" to an objective-ideal operator dashboard for a personal-data-protocol reference implementation. Audiences: engineers evaluating adoption, a CEO showing investors, standards reviewers.
**Constraint:** We are *elevating* the existing brand, not re-pointing it. Every recommendation preserves the encoded trust semantic (protocol-vs-human, cool-blue vs warm-accent) and the dark-default operator surface.

---

## 0. The current brand, honestly assessed

Current tokens (`packages/pdpp-brand/base.css`) are already past amateur in several respects: OKLCH throughout, a real dark theme tuned on charcoal (not purple-on-black), semantic washes, a motion vocabulary with reduced-motion handling, and a *meaningful* trust distinction baked into surface treatments (`[data-surface="protocol"]` blue left-border, `[data-surface="human"]` warm left-border). That trust semantic is the brand's genuine differentiator and must survive the redesign.

What reads as "a programmer made this without a designer":

1. **No spacing scale.** There are no named spacing tokens. Spacing is therefore applied ad hoc (`mb-2`, `px-2.5`, `gap-0.5` seen in shell code) with no rhythm. This is the single biggest amateur tell — polished systems have one spacing scale and never deviate.
2. **One radius, used everywhere.** `--radius: 0.5rem` is the only radius token. Polished systems have a small *scale* (sharp for tables/inputs, rounded for cards, pill for badges) chosen intentionally per component class.
3. **Type scale has gaps and a soft middle.** Jumps from 20px heading straight to 14px title; the 12px label and 12px caption are the *same size* differentiated only by weight; there is no 16px step; data tables have no tabular-figure treatment at all.
4. **Decorative gradients fighting a dense surface.** The body radial-gradient corner wash + the `[data-surface]` linear-gradient fills are "marketing-page" moves that add visual noise to an operator surface meant for long sessions. Leading dev tools strip exactly these.
5. **Shadows doing elevation work.** `box-shadow: 0 1px 2px / 0 1px 3px` on protocol/human surfaces. Modern dev-tool elevation is **borders + tints**, not drop shadows — shadows read as cheap on dark surfaces.
6. **No tabular numerals.** For a dashboard whose whole job is showing records, counts, amounts, timestamps, the absence of `tabular-nums` is the clearest "no designer was here" signal in the entire system.

The good news: the bones are right. The work is *discipline and restraint*, not a rebuild.

---

## 1. DENSITY & LAYOUT

### What the references actually do

**Linear** ran a six-week, dedicated (not side-project) redesign whose explicit goal was to "reduce visual noise, maintain visual alignment, and increase the hierarchy and **density** of navigation elements." Density is treated as a *feature*, achieved by tightening the sidebar/tabs/headers/panels and harmonizing alignment — not by cramming. Their layout vocabulary is a fixed set of structured views: list, board, timeline, **split** (master-detail), fullscreen. The split view is the canonical operator pattern: scannable list on the left, full meta/properties panel on the right.

**Stripe** is the benchmark for "density with purpose." Power-user dashboards "prioritize information density over whitespace" — but every element earns its space. The canonical Stripe patterns:
- **Metric strip:** 4 cards, each = label (one word) + number + trend arrow/% + sparkline. No verbose labels ("Revenue", not "Total Revenue for Current Period").
- **Sortable table → side panel detail.** The table stays scannable; clicking a row opens the full record in a right-side panel. This is *progressive disclosure*: the single most important thing first, drill-down on demand.
- Functional color only — green for success, red only for failure.

**Vercel/Geist** leans hardest into reduction: near-monochrome, content carries the page, chrome recedes. Density comes from removing decoration, not adding rows.

**Plaid** (consumer-trust side) lands on the same master-detail spine: persistent sidebar = master nav, lead with a prominent summary (total + trend), high-priority KPIs at top, transaction/record detail in an adjacent or lower pane. Its developer dashboards add an **integration-health surface** — connection quality, conversion, risk at a glance — which is *exactly* the shape PDPP's connector-health dashboard wants.

### Concrete density numbers (from enterprise data-table UX research)

- **Row-height tiers:** Condensed 40px / Regular 48px / Relaxed 56px. Offer a density toggle (icon switcher *outside* the table) and **persist the choice** per user/session. For an operator default, **Regular 48px** with **Condensed 40px** available.
- **Cell padding math:** ~8px between text and row border yields ~16px text-to-text across rows — equivalent to paragraph spacing, the readability sweet spot. Don't go below this on the default density.
- **Dense ≠ cramped:** "compress whitespace with discipline." In dense contexts use tight-but-consistent 4/8/12px padding rather than 16–24px, because the surrounding elements (buttons, fields, text) are also small, so the balance stays harmonious.
- **Sticky header on vertical scroll; sticky first column on horizontal scroll** (and optionally a sticky rightmost totals column).
- **Drop zebra stripes.** They were standard, now an anti-pattern: striping + hover + selected + disabled = up to five grey swatches competing, which breaks visual continuity. Use a single hairline row divider (or no divider with sufficient row height) and let hover/selected be the only background changes.

### POV for PDPP layout

- **Adopt master-detail as the primary operator pattern.** Records, connections, runs, dead-letters, grants — all of these are "list of things → inspect one." Standardize a `list + right detail panel` (Linear "split") layout shell rather than full-page navigation for every drill-down. (The console already has list and drill-down routes; the move is making the detail a *panel*, not a separate page, for the high-frequency surfaces.)
- **One operator metric strip at the top of the dashboard home.** Stripe-style: connections healthy/total, records synced, last-run status, pending grants. Number + trend + (optional) sparkline. No paragraphs.
- **Kill decorative gradients on operator surfaces.** Remove the body radial corner-wash and the `[data-surface]` linear-gradient fills *for the console*. Keep the trust semantic via the left-border + a flat 1-step tint (see §2). Gradients can stay on the *marketing/site* surface where they belong.

---

## 2. COLOR & ELEVATION

### What the references actually do

**Linear** rebuilt theme generation on **LCH instead of HSL** specifically because LCH is perceptually uniform — a red and a yellow at lightness 50 read as equally light, so generated themes stay consistent regardless of base color. They treat light and dark as a **paired mapping from core variables**, not "design light, then adapt." They deliberately **cut color back** over time toward "a more neutral and timeless appearance" by limiting how much hue appears, raising overall contrast. The 2025 direction went further: near-monochrome, color reserved for meaning.

**Vercel/Geist** is the reference for restraint and for **elevation-via-token, not shadow**:
- Two page backgrounds: **Background 1** (default) and **Background 2** (used *sparingly* for subtle differentiation).
- **Component-background triple:** Color 1 = default, Color 2 = hover, Color 3 = active. Interactive surfaces change *fill step*, not shadow.
- **Border triple** (Colors 4–6) for component borders — borders are first-class elevation, not afterthoughts.
- A **Material** elevation component encodes role (`base` resting cards → `small`–`large` raised → `tooltip`/`menu` popovers → `modal` → `fullscreen`). Rules that separate pro from amateur: *don't stack two materials on one element; align elevation to the z-index band; favor the lowest elevation that still reads as elevated — over-elevating is a top source of visual noise; never rely on shadow alone — pair with the focus-visible ring.*

The consistent message across Vercel + Linear: **on a dark operator surface, elevation = a step up in surface fill + a hairline border, with shadow reserved almost entirely for truly-floating layers** (menus, popovers, modals).

### Keeping a dark surface calm over long sessions

PDPP already does the right base thing: charcoal `oklch(0.16 0.005 260)`, not pure black; near-neutral chroma. To make it *calm*:
- **Reduce simultaneous accent hits.** Calm comes from monochrome dominance with rare, meaningful color — Linear's explicit lesson. The current dark theme has blue primary, warm human, green success, amber warning, and a purple-ish edu-fg all potentially on screen. That's a lot of hue for a long session.
- **Elevate with fill steps, not shadow.** Define an explicit surface ladder (page → card → raised → overlay) as discrete OKLCH lightness steps, each ~+0.03–0.04 L over the last, paired with one border step. Drop the `0 1px 2px/0 1px 3px` shadows on resting cards entirely.
- **Reserve saturated washes for *state changes*, not resting chrome.** A row isn't "success-washed" because it's fine — it's washed only when something happened.

### Evolving the cool-blue / warm-human duality (without losing the semantic)

The protocol-vs-human distinction is the brand's soul. Keep it; refine the execution:

1. **Demote the wash, promote the marker.** Today both surfaces carry a left-border *and* a gradient fill. Refine to: **a 2px left-border + a single flat tint at the card-fill level** (one step, no gradient). The hue still says "protocol" (blue) vs "human" (warm), but quietly. Borrow Geist's discipline: the differentiation is *subtle by default*, legible on inspection.
2. **Tighten the warm accent so it reads as a sibling of blue, not a different temperature family.** Current human `oklch(0.52 0.09 45)` (light) / `0.78 0.10 55` (dark). Consider nudging hue toward amber-gold (≈ 60–70) and trimming chroma slightly so it reads as "the warm counterpart in the same palette" rather than a rust/brown. The relationship between the two should feel *engineered as a pair* (Linear's paired-mapping philosophy), e.g. matched lightness and matched chroma magnitude, opposed hue.
3. **Resolve the success/human collision.** Success-green and verified-wash are the *same* token (`--verified-wash` = success-wash). Meanwhile "human" is warm and "protocol" is blue. Make sure the four signal hues occupy clearly separated positions on the wheel and that no two semantics share a swatch a reviewer could confuse (verified vs success is the one to disambiguate or deliberately unify with a comment).
4. **Quiet the edu-fg.** `oklch(0.78 0.08 280)` reads purple-ish — the one hue that pulls toward "generic AI dark mode." Pull it toward the neutral/blue family or drop chroma so it reads as informational, not decorative.

---

## 3. TYPOGRAPHY

### What the references / research say

- **Sans with tabular figures beats monospace for numeric data.** Reserve monospace (JetBrains Mono — keep it) for genuinely code-like content: IDs, tokens, file paths, command strings, API refs, terminal/log output, JSON. For *numbers in tables* use the sans face with `font-variant-numeric: tabular-nums lining-nums`. This is the highest-leverage typographic change available.
- **Tabular nums are the marquee fix.** Without them, `$1,111.11` looks narrower than `$999.99` and columns don't align. Set `font-variant-numeric: tabular-nums` (with `lining-nums`) **globally on data containers / tables**, and keep it consistent (don't mix oldstyle/lining).
- **Restraint:** one family, ~3 weights, ~4 sizes per surface. Reserve bold strictly for primary KPIs / critical numbers — "if everything is bold, nothing is prioritized."
- **Cell sizing:** ~13–14px at line-height ~1.4 is the density/readability sweet spot for table cells. Avoid weights ≤200 at ≤13px (they vanish off high-DPI).
- **Alignment:** text left-aligned, numbers right-aligned, dates left-aligned (qualitative numbers), headers align to their column content.
- **Scale ratio:** dashboards benefit from a slightly stronger ratio than the gentle Major Third — hierarchy must do more work in constrained space. A ~1.2–1.25 step in the body range, opening up toward display, is appropriate.
- A popular dev-tool move: **mono for large display headings**, sans for body — instantly signals "technical product" without hurting readability. PDPP already does a lighter version of this with `.pdpp-eyebrow` (mono uppercase). This is good brand equity to lean into.

### Is the 14px base right?

**Yes — keep the 14px base.** 14px is the correct operator/dev-tool body size (Linear, Stripe, GitHub, Vercel all sit at 13–14px for dense UI). The problem isn't the base; it's the *scale around it*:

- **The 12/12 collapse:** `.pdpp-label` (12px/500) and `.pdpp-caption` (12px/400) are the same size. That's fine if intentional (weight-differentiated), but the scale then has **no distinct small step below 12** for true fine print and **no 16px step** between 14 (body) and 20 (heading). The mid-range is the soft spot.
- **Recommended scale** (single family, tighter steps, one new mid step): caption 12 / **body 14** (base) / body-lg 16 (new, replaces the 18 in dense contexts) / title 14·600 / heading 18–20 / display 30 / display-lg 48–60. Trim display-lg from 60 toward ~48 for the operator surface (60 is a marketing size).
- **Add a dedicated numeric/data type treatment**, not just a class: a `.pdpp-num` (or a table-scoped rule) applying `font-variant-numeric: tabular-nums lining-nums` so every amount, count, and timestamp aligns.

---

## 4. COMPONENT SYSTEM

### What separates polished from amateur

The reference systems (Geist most explicitly) show that polish is **consistency of primitives**, not cleverness:

1. **One spacing scale, named, never deviated from.** 4/8/12/16/24/32/48… as tokens (`--space-1`…). This is the #1 differentiator. Geist composes everything from `<Stack>` spacing; Linear's whole redesign was alignment discipline.
2. **A small radius *scale*, not one radius.** 3 steps: e.g. `--radius-sm` (inputs, table cells, badges — sharp), `--radius-md` (cards, panels), `--radius-lg`/pill (badges/avatars). Intentional per component class.
3. **Elevation as token, not ad-hoc shadow.** A surface ladder (page/card/raised/overlay) + a Geist-style "use the lowest elevation that still reads elevated" rule.
4. **Intentional, complete states.** Every interactive primitive needs default / hover / active / focus-visible / disabled / loading / error — Geist's Color 1/2/3 (default/hover/active) is the template. The "programmer-made" tell is a button with only default + hover.
5. **One focus ring, everywhere.** A single `:focus-visible` ring token (PDPP has `--ring`) applied uniformly — and *paired with elevation* on floating surfaces, never shadow-only.
6. **Motion vocabulary used consistently.** PDPP already has a strong one (`--motion-enter/exit/state/feedback`, reduced-motion). The amateur risk is *not using it* — applying raw transitions inline. Enforce the tokens.

### The primitive set PDPP needs (and mostly has)

- **Status badge** — the workhorse for a connector/run/grant dashboard. Needs a fixed set of states (healthy/verified, syncing, warning, error/blocked, stalled, paused/draft) each mapping to one semantic hue + wash. Geist's Badge/Pill is the model; pill radius, 12px label, tabular if it carries a count.
- **Button** — primary / secondary / ghost / destructive, all 5 states, one focus ring, one radius (sm or md, pick one).
- **Input / Select** — sharp radius, `--input` border, focus ring, error state. Geist's Input.
- **Card / Section** — the `[data-surface]` protocol/human surfaces refined to border+tint (no gradient, no resting shadow).
- **Data list / table** — the big one: tabular-nums, right-aligned numbers, sticky header, density toggle, hairline dividers (no zebra), row hover, selected state, row → detail panel.
- **Toolbar** — filters / search / density toggle / view switch above tables (Linear's "additional headers to store filters and display options").
- **Empty state** — Geist has a dedicated Empty State component; PDPP should have one pattern (icon + one line + one action), not bespoke per page.
- **Callout / Note** — for the educational/standards-reviewer audience (the `edu-fg` token's purpose). Geist's Note. Quiet by default.
- **Metric card** — Stripe pattern (label + number + trend + optional sparkline).
- **Detail panel / sheet** — right-side panel for master-detail drill-down (Geist Sheet/Drawer).

---

## 5. CONCRETE RECOMMENDATIONS FOR PDPP (prioritized)

Prioritized P0 (highest leverage, lowest risk) → P3 (refinement). Token names illustrative.

### P0 — The "no designer was here" fixes (do these first; cheap, transformative)

1. **Introduce a named 4/8px spacing scale.** Add `--space-1: 4px` … `--space-12: 48px` (4, 8, 12, 16, 20, 24, 32, 40, 48). Make it the single source of truth; stop ad-hoc `mb-2`/`gap-0.5`. *This is the biggest single jump from amateur to professional.*
2. **Add tabular figures to all data.** Global rule on tables/data containers: `font-variant-numeric: tabular-nums lining-nums;` and a `.pdpp-num` utility. Right-align numeric columns, left-align text/date columns.
3. **Tighten the radius scale to 3 steps.** Replace the single `--radius: 0.5rem` with `--radius-sm: 0.375rem` (inputs/cells/badges), `--radius-md: 0.5rem` (cards/panels), `--radius-lg: 0.75rem` (large containers) + pill (`9999px`) for status badges/avatars. Map each component class to exactly one.
4. **Remove decorative gradients from the operator surface.** Drop the `body` radial corner-wash and the `[data-surface]` `linear-gradient` fills *in the console*. Keep the marketing wash on the public site only.
5. **Replace resting drop-shadows with border+tint elevation.** Remove `box-shadow` from `[data-surface="protocol"]`/`[data-surface="human"]` resting cards. Define a surface ladder: `--surface-page` (0.16 L), `--surface-card` (0.20 L), `--surface-raised` (≈0.235 L), each with its paired border step. Reserve shadow for floating layers only (menu/popover/modal/sheet).

### P1 — Layout & component spine

6. **Standardize a master-detail (split) shell** for high-frequency operator surfaces (records, connections, runs, dead-letters, grants): scannable list + right detail panel, not page-to-page nav. Sticky table header; sticky first column on horizontal scroll.
7. **Add a density toggle** (Condensed 40px / Regular 48px) with per-user persistence; default Regular. Hairline row dividers, **no zebra stripes**, hover + selected as the only row background changes.
8. **Ship a canonical `StatusBadge`** with a fixed enum (healthy/verified · syncing · warning · error/blocked · stalled · paused/draft), each → one semantic hue + wash, pill radius, 12px label.
9. **Ship a Stripe-style metric strip** on dashboard home (label + number + trend + optional sparkline). One word labels.
10. **Audit every interactive primitive for the full state set** (default/hover/active/focus-visible/disabled/loading/error). Adopt Geist's Color-1/2/3 (default/hover/active fill-step) model rather than shadow/opacity hacks.

### P2 — Color & type refinement (preserve the trust semantic)

11. **Refine the protocol/human surfaces** to `2px left-border + single flat card-level tint` (no gradient). Keep blue=protocol, warm=human. Quiet by default, legible on inspection.
12. **Re-engineer the warm accent as a true sibling of the blue primary.** Match its lightness and chroma magnitude to the primary; nudge hue toward gold (~60–70) so the pair reads as one engineered palette, not two temperatures. Example direction (validate visually): dark `--human: oklch(0.78 0.10 65)`; light `--human: oklch(0.55 0.10 60)`.
13. **Quiet `--edu-fg`.** It reads purple (the "generic AI" tell). Pull toward neutral/blue or drop chroma: e.g. dark `oklch(0.78 0.05 250)`.
14. **Reduce simultaneous accent load.** Establish a rule: at most the primary + one state hue active in any single view region; saturated washes signal *state changes*, never resting chrome.
15. **Disambiguate verified vs success** (currently the same token). Either deliberately unify with a documented comment, or split: keep success-green for run/sync outcomes, give "verified" a distinct treatment (e.g. blue-protocol family, since verification is a protocol act).
16. **Fix the type-scale mid-range:** add a 16px `body-lg` for dense contexts, distinguish label (12·500) from a true 11px fine-print caption if needed, trim `display-lg` from 60 → ~48 for the operator surface. Keep the 14px base. Enforce one family, ~3 weights, ~4 sizes per surface; bold reserved for primary KPIs.

### P3 — Polish & system hygiene

17. **One focus ring everywhere**, paired with elevation on floating surfaces (never shadow-only) — Geist accessibility rule.
18. **Enforce the existing motion tokens** (`--motion-*`); forbid inline raw transitions. The vocabulary is good; the discipline is the gap.
19. **Single empty-state and callout pattern** (icon + one line + one action) instead of bespoke per page.
20. **Document the surface/elevation ladder and the protocol-vs-human semantic** on the `/design` page so the three audiences (engineers, CEO/investors, standards reviewers) can *see the system is intentional* — the meta-signal that a designer was involved.

---

## Appendix: Source map

- **Linear UI redesign (LCH theming, density-as-feature, split views, six-week dedicated effort, cut color toward neutral/timeless):** https://linear.app/now/how-we-redesigned-the-linear-ui
- **Linear 2025 direction (monochrome, less color), dashboards/drill-down:** https://blog.logrocket.com/ux-design/linear-design/ ; https://linear.app/changelog/2025-07-24-dashboards
- **Vercel Geist colors (Background 1/2, Color 1/2/3 component bg, Border 4/6):** https://vercel.com/geist/colors
- **Vercel Geist Material (elevation-by-type, lowest-elevation rule, no-shadow-alone):** https://vercel.com/geist/material
- **Geist near-monochrome philosophy / semantic tokens:** https://seedflip.co/blog/vercel-design-system ; https://imperavi.com/blog/designing-semantic-colors-for-your-system/
- **Stripe dashboard (density-with-purpose, metric strip, table→side-panel, functional color, WCAG token generation):** https://mattstromawn.com/projects/stripe-dashboard/ ; https://docs.stripe.com/dashboard/basics ; https://artofstyleframe.com/blog/dashboard-design-patterns-web-apps/
- **Plaid (trust via recognition, integration-health dashboard, master-detail summary-then-drill):** https://plaid.com/blog/inside-link-design/ ; https://plaid.com/use-cases/open-finance/ ; https://www.eleken.co/blog-posts/trusted-fintech-ui-examples
- **Enterprise data-table UX (40/48/56 density tiers, drop zebra, freeze column, alignment, density toggle + persistence):** https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables
- **Typography for data UIs (tabular-nums, sans+tnum > mono for numbers, 13–14px cells, one family/3 weights/4 sizes):** https://blog.datawrapper.de/fonts-for-data-visualization/ ; https://fontalternatives.com/blog/best-fonts-dense-dashboards/ ; https://alistapart.com/article/web-typography-tables/
- **Data density discipline (compress whitespace, 4/8/12px in dense contexts):** Linear redesign + data-density best-practice literature (paulwallas.medium.com — 403 on fetch, corroborated via search synthesis)
