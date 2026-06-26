# Explore date controls — SLVP-ideal design (pilot cell)

**Status:** ✅ LAND — Codex re-review confirmed >95% execution-ready (all 4 blockers addressed; "no
better high-level pattern found; this is the right SLVP pattern"). One implementation note (not a
blocker): `before`/`after` grammar comments+tests currently say "strict" — during build, update that
wording or add `from`/`to` aliases so operator semantics can't contradict the inclusive-local-day Date
chip. Pilot complete; the recipe (`../RECIPE.md`) is proven. Prior art: `./prior-art.md`
(14 sources; canonical refs = Grafana time-picker, GitHub Primer "journey of a date picker," Linear
chip-as-editor, Datadog sliding/growing/fixed honesty taxonomy). **Code audit corrected** against
deploy tip `36d51f49` (`workstream/explore-feel-integration`), citations re-verified by content.

## CHANGELOG — what the Codex HOLD changed (the pilot's lesson)
- **B1 stale code refs (a Part-0 self-violation):** my first draft cited ~L1170; that was wrong (an
  MCP-area line). RE-AUDITED by content: date buttons = `explore-canvas.tsx:1102-1106` (`rr-x-ranges`,
  the `today/7d/30d/all` map); `setRange` = `:2990` (hard-clears `until: ""`); redundant range chip =
  `:452-458` (`rangeLabel` pushed into the chip strip). Defect confirmed, now precisely located.
- **B3 canonical-state (the big one):** Explore ALSO has `before:`/`after:` operators. The grammar
  (`explore-grammar.ts:16-17,56-59`) already documents `after:→since`, `before:→until` — so operators
  and the date control converge on the SAME server params, but the UI does NOT unify them (a user could
  hold a `7d` chip AND an `after:…` token = two representations). FIX below: one canonical date object;
  operators normalize INTO it.
- **B2 honesty semantics + B4 test matrix:** added below.

## The two defects this closes
1. **No specific-date / custom-range picker** — only `Today/7d/30d/All` shortcut buttons exist.
2. **Double-representation** — a selected shortcut shows BOTH a highlighted button AND a separate
   "Since 2026-06-12" chip. One state, two renders = a Part-0 regret-check violation.

## The SLVP-ideal pattern (one control, one chip, one honest statement)
Replace the four standalone shortcut buttons AND the separate "Since…" chip with **ONE "Date" chip
that is both the active-state display and the editor** (Linear/Grafana model).

- **Resting state, no filter:** a quiet `Date` chip (or "Any time") in the chip row — not four buttons.
- **Click → hybrid popover** (Grafana's one-popover-does-both):
  - **Presets** (apply instantly, close popover): `Today · Last 7 days · Last 30 days · All time`.
  - **Custom:** `From` / `To` date inputs backed by a calendar; an explicit **Apply** button (Primer's
    documented lesson: do NOT auto-submit — the user sets two endpoints, then commits).
  - Presets and Custom share the popover; picking a preset reflects into From/To so the resolved range
    is always visible (Primer's fix for "a preset that hid the resolved range").
- **Active state = the chip label, derived from `(since, until)` as ONE honest phrase:**
  - relative preset (end = now): `Last 7 days`
  - anchored/growing (since set, until empty): `Since Jun 12`
  - fixed window (both set): `May 1 – May 14`
  - The chip carries a `×` to clear → back to "Any time". **No second representation anywhere.**

### THE CANONICAL DATE-FILTER OBJECT (Codex B3 — the core of the LAND)
There is exactly ONE date filter, derived from `(since, until)`, rendered as ONE chip, edited by ONE
popover. Every entry path normalizes into it:
- The Date chip/popover writes `since`/`until` (it already does, `:2990`).
- Typed `after:<DATE>` / `before:<DATE>` operators are **lifted out of the token stream into the same
  `since`/`until`** (mirror the existing `liftFacetTokens` pattern, `explore-grammar.ts`), so a typed
  date operator IMMEDIATELY becomes the Date chip — never a separate token chip beside it.
- The URL `since`/`until` params are the single source of truth; the chip label is a pure function of
  them. **Result: no path produces a second date representation.**
- Conflict rule: typing `after:X` while a preset is active REPLACES the canonical `since` (last-write
  wins, like any filter edit) and re-derives the chip; it does not stack.

### Honesty semantics (Codex B2 — must be exact, this is a personal-data tool)
The label must not let a relative window read as frozen, AND the boundary math must not lie:
- **Sliding** (`Last 7 days`, end = now) · **growing** (`Since Jun 12`, since-only) · **fixed**
  (`May 1 – May 14`, both set). The derived label states which — never a bare "Since…".
- **Timezone:** all boundaries are the OWNER'S LOCAL timezone (their data, their day). The label and the
  calendar operate in local time; conversion to the server's `since`/`until` (ISO) happens at the edge.
  A record's day-grouping in the feed must use the SAME local tz so the filter and the feed agree.
- **Inclusivity:** `until`/`To` is **inclusive of the whole selected end day** (local) — "to May 14"
  means through 23:59:59.999 local on May 14, not midnight. `since`/`From` is inclusive from 00:00:00
  local. (Matches user mental model; documented so the server mapping is unambiguous.)
- **"Today"** = local calendar day 00:00→now (sliding). **"Last 7 days"** = rolling 7×24h ending now,
  NOT 7 calendar days — label says "Last 7 days" (rolling), and the popover tooltip shows the resolved
  `From … To now` so the exact window is never hidden (Primer's resolved-range lesson).
- This is the honesty invariant the cell ADDS to THE-LENS Gate 1: **a date filter is one honest
  statement of the active window — its end-behavior (sliding/growing/fixed) AND its tz/inclusivity
  legible, never a boundary that lies about which records it includes.**

## Why this is cheap (verified in code @ 36d51f49)
- The URL contract already carries `since` AND `until` (`explore-navigation.ts` HrefOpts).
- `activeRangeKey` (`explore-control-state.ts:15`) already returns `"custom"` when `until` is set —
  the custom-range *state* is already modeled; only the *control* and *label* are missing.
- The redundant chip comes from `rangeLabel` being pushed into the chip strip (`explore-canvas.tsx`
  ~3052 → ~452). Deleting that push + deriving the label inside the single Date chip removes the double
  representation with no query-layer change.
- **What to build:** (1) a `DateChip` + popover (presets + From/To calendar + Apply); (2) `setRange`
  stops hard-clearing `until`, accepts a `{since, until}` custom range; (3) a pure `dateChipLabel(since,
  until, now)` deriving the one honest phrase; (4) remove the `rangeLabel`→chips push. No new URL params.

## UI / states (exact)
- Chip (resting): `Any time` · muted, sans.
- Chip (active): the derived phrase · `×` to clear. Sans for the phrase; **mono only for the literal
  dates** inside Custom inputs (machine values) per the mono rule.
- Popover: presets list (left/top) · `Custom` section with `From`[date] `To`[date] + `Apply`.
- Placeholder/disabled `To` < `From` guarded; empty Custom = no-op (Apply disabled).
- Keyboard: chip is a button (Enter/Space opens); popover trap; Esc closes without applying; presets are
  a radio-group; Apply is the default action in Custom.
- Mobile: same chip; popover becomes a full-width sheet (matches the existing mobile filter sheet).

## Acceptance criteria + TEST MATRIX (Codex B4 — executable)
UI/behavior:
- [ ] No standalone Today/7d/30d/All buttons remain; one Date chip in their place.
- [ ] Custom range selectable via calendar; `until` persists in the URL and survives reload.
- [ ] Exactly ONE active representation — the chip; the separate `rangeLabel` chip push (`:452-458`) is
      removed (assert no `rangeLabel` element renders alongside the Date chip).
- [ ] Mono only on literal date inputs; the chip phrase is sans.
- [ ] Picking a preset reflects into From/To (resolved range visible); popover tooltip shows resolved
      `From … To now` for rolling presets.
- [ ] Reduced-motion + keyboard (radio-group presets, Esc cancels, Apply default) + mobile-sheet covered.

Pure-logic test matrix (`dateChipLabel` + normalization — these are the >95% proof):
- [ ] **label cases:** sliding (`Last 7 days`) · growing (`Since Jun 12`) · fixed (`May 1 – May 14`) ·
      empty (`Any time`) — each derives correctly from `(since, until)`.
- [ ] **timezone boundary:** a record at 23:30 local on the `To` day is INCLUDED; the same UTC instant
      that is the next local day is EXCLUDED — assert local-tz inclusivity, no UTC off-by-one.
- [ ] **inclusivity:** `To = May 14` includes 23:59:59.999 local May 14; `From = May 1` includes
      00:00:00 local May 1.
- [ ] **typed → chip normalization:** typing `after:2026-01-01` produces the Date chip (since set), NOT
      a separate token chip; `before:` likewise sets `until`; both → fixed window.
- [ ] **conflict / last-write:** `after:X` while a preset is active replaces `since`, re-derives one chip.
- [ ] **chip → URL → reload roundtrip:** set custom range → URL carries `since`+`until` → reload restores
      the exact chip + popover state.
- [ ] **clear:** `×` returns to `Any time`, drops `since`/`until` from URL, removes any lifted operator.

## Self-critique vs THE-LENS (the >95% gate) — post-HOLD
- **Part 0 regret-check:** kills the double-representation, INCLUDING the operator-vs-chip overlap Codex
  caught (the canonical object is the fix) ✓; 4 buttons → 1 chip ✓; no machine/slop copy ✓; no
  boundary that lies (tz/inclusivity specified) ✓; code claims re-verified by content on the real tip ✓.
- **Gate 1 honesty:** adds TWO invariants to the lens — (a) sliding/growing/fixed legibility, (b) local-tz
  inclusivity (no boundary lie). Both fold back into THE-LENS Gate 1.
- **Gate 4 feel:** chip-as-editor + one popover = the exact Linear/Grafana pattern (cited), not invented.
- **Residual <5% (bounded, non-correctness):** exact popover layout (preset-list vs segmented) — a visual
  A/B against the Linear/Grafana shots. Calendar component — reuse a brand-package primitive if one
  exists, else a minimal accessible date input; confirm at build. Neither touches the model, the
  canonical-object guarantee, or the honesty semantics.

## Send back to Codex to confirm LAND
The four blockers are addressed: B1 (corrected by-content audit), B2 (tz/inclusivity/sliding semantics),
B3 (canonical date object; operators normalize in), B4 (test matrix incl. tz boundary + typed→chip +
roundtrip). Re-review → expected LAND.

## DEFINITION OF DONE — pixel gate (mandatory, not the merge)
A spec is not a render. This cell is DONE only when the BUILT control is captured live (desktop 1440 +
mobile 390) and put SIDE-BY-SIDE against the kept product-UI references, and the pixels stack up:
- `../../slvp-benchmark-2026-06-23/shots/vercel-changelog-deployments-list-desktop.png` — the
  "Select Date Range" dropdown + filter-dropdown row is the target: one quiet control, opens a picker,
  no double-representation, sits inline in the filter row at the same weight.
- `../../slvp-benchmark-2026-06-23/shots/linear-docs-filters-desktop.png` — chip/filter anatomy + the
  active-state treatment.
Acceptance = a human (the owner) confirms the side-by-side matches; "DOM says the classes are right" is NOT
done (THE-LENS Part 0). If the live render diverges from the reference, iterate before calling it done.
