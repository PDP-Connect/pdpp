# Explorer designer-parity: what remains after the SLVP foundation landed

Status: captured
Owner: reference implementation owner
Created: 2026-06-01
Updated: 2026-06-01
Related: openspec/changes/archive/2026-05-31-complete-explorer-slvp-ideal, openspec/changes/archive/2026-06-01-add-explorer-live-presentation-types, design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md, packages/operator-ui/src/lib/record-kind.ts, packages/operator-ui/src/components/views/records-explorer-view.tsx, docs/explorer/uat/97dc8b80/, docs/voice-and-framing.md

## Question

The owner challenged whether "Explorer design" is actually complete. The SLVP
*foundation* is complete and proven; the *designer-parity* surface is not. What
precisely remains, and which remaining pieces are product-UI-only (a worker can
ship them now) versus contract- or decision-gated (need OpenSpec or an owner
call first)?

## Context

The Explorer (`/dashboard/explore`, operator console; `/sandbox/explore`,
sandbox) is a mature surface. As of this note it already does, honestly:

- type-aware cards dispatched from the declared `field_capabilities[].type`
  (landed by `add-explorer-live-presentation-types`), with the `record-kind.ts`
  heuristic as the fallback for un-annotated manifests;
- correct cents formatting for declared-`currency` amounts (the live-vs-fixture
  bug closed; proof in `docs/explorer/uat/97dc8b80/`);
- recency / time-range / search lenses, day grouping, an activity strip, a
  connection facet line, a stream facet line, a per-chip-removable active-filter
  summary (this lane), honest partial-result warnings, an exact-window corpus
  caption, and a field-projection-truthful peek panel (withheld fields shown as
  withheld, blob affordances gated by grant);
- connection identity preserved end-to-end (two Gmail connections are two
  chips and two row attributions, never collapsed).

`complete-explorer-slvp-ideal` accepted the SLVP-ideal *target* as a no-code
spec change; `add-explorer-live-presentation-types` implemented the typed-card
foundation it depended on. Both are archived. So the gap is not "the Explorer is
unfinished" — it is the delta to the **designer artifact's** richer surface.

## The remaining delta (designer artifact vs. live)

The designer SPA (`PDPP Explorer.html`, gitignored; see memory
`project_explorer_designer_artifact`) dispatches **8** card kinds and carries
two affordances the live surface does not:

| Remaining item | Live today | Gate |
| --- | --- | --- |
| `photo` card (image/blob tile) | falls to `titled`/`generic`; blob is a link affordance only | **contract-gated** — needs a declared `blob`/`image` type + an inline-renderable blob read; partially present (`type: "blob"` already drives the peek blob affordance) |
| `activity` card (workout/trip/session metrics) | falls to `event` | product-UI-only *if* the metrics are already in the body; otherwise no new fields needed, just a card body |
| `reader` card (long-form article/document body) | falls to `titled` | product-UI-only — reads the body the recency/time-range lens already holds |
| `location` card (place/coords) | falls to `generic`/`event` | product-UI-only *if* coords are in the body; a declared `geo`/`location` type would make it a declaration not a guess |
| per-stream **view switcher** (table / cards / raw) | single card list | product-UI-only — pure presentation state in the URL, no contract change |
| grant-projection / `redacted_reason` **toggle** | peek shows withheld fields; no feed-level toggle | **decision-gated** — `complete-explorer-slvp-ideal` explicitly reserves client-grant/field-projection chrome for a future *data-owner* surface holding a real client-scoped grant; the owner-token console "SHALL NOT invent it". So this is not a free UI add — it is owner-reserved. |

`RecordKind` is currently `message | money | event | titled | generic`
(`record-kind.ts:28`). The designer adds `photo | activity | reader | location`.

## Stakes

- Shipping `activity` / `reader` / `location` card bodies is the same class of
  presentation-only work the existing money/message cards are: read the body the
  feed already holds, render a kind-specific layout, degrade to the one-line
  summary when fields are absent. No contract change, no protocol claim. These
  are the highest-value, lowest-risk remaining slices.
- `photo` is the one card that genuinely wants a contract touch: an
  inline-renderable image needs either a declared `image` presentation type or a
  grant-safe thumbnail read. The blob *affordance* (link / unavailable-under-
  projection) already exists; an inline tile is the increment. Treat it as a
  small additive read-contract slice, sibling to `add-explorer-live-presentation-types`,
  not a UI-only change.
- The grant-projection **toggle** is deliberately *not* a no-regret UI add. The
  accepted spec reserves grant/field-projection chrome for a future data-owner
  surface. Building it on the owner-token console would contradict
  `complete-explorer-slvp-ideal`'s framing ("the owner-token operator console
  SHALL NOT invent it"). It needs an explicit owner decision — either a new
  surface or a spec amendment — before any code.
- The **view switcher** is cheap and safe, but it is the kind of change that can
  silently fork sandbox/live parity if added to only one. Add it through the
  shared `records-explorer-view.tsx` so both surfaces get it, or not at all.

## Current Leaning

Slice the remainder into three tranches, in priority order:

1. **Product-UI-only card bodies** (`activity`, `reader`, and `location` when
   coords are in the body). Extend `RecordKind`, the heuristic and declared-type
   dispatch in `record-kind.ts`, and `PREVIEW_BODY_BY_KIND` in
   `records-explorer-view.tsx`. Reuse the existing presentation-only seam; no
   contract change; ship with unit tests for each new kind's dispatch + preview,
   and one bounded UAT recapture. This is a clean worker lane and the most direct
   answer to "is the Explorer at the designer bar."
2. **`photo` inline tile** — a small additive read-contract slice (declared
   `image` type and/or a grant-safe thumbnail read), modeled on
   `add-explorer-live-presentation-types`. OpenSpec first.
3. **Grant-projection feed toggle and per-stream view switcher** — owner-decision
   inputs, not worker lanes. The toggle needs a surface/spec decision; the view
   switcher needs a yes plus a shared-component commitment so sandbox and live
   stay in parity.

No-regret UI hardening that does **not** need any of the above already shipped in
this lane (per-chip filter removal; singular count grammar).

## Promotion Trigger

Promote to OpenSpec before implementing any of:

- a new declared presentation `type` (e.g. `image`, `geo`/`location`) on stream
  metadata, or any inline blob/thumbnail read beyond the existing affordance;
- any grant-projection / `redacted_reason` chrome on the operator console (this
  also needs an owner framing decision, not just a spec);
- any feed-level read capability a card needs that the recency/time-range/search
  responses do not already carry.

Tranche 1's `activity` / `reader` / `location` card bodies are explicitly **not**
a promotion trigger when they read only the body the feed already holds and
invent no contract noun — the same bar the shipped money/message cards cleared.

## Decision Log

- 2026-06-01: Captured during the `ri-explorer-design-slvp-v1` audit lane after
  the owner challenged Explorer completeness. Found the SLVP foundation complete
  and proven (typed cards live, money-format bug closed, committed UAT), and the
  remaining gap to be designer parity: 3 product-UI-only card kinds, 1
  contract-gated `photo` tile, and 2 owner-decision-gated affordances (grant
  toggle, view switcher). Shipped the no-regret UI hardening (per-chip filter
  removal, singular count grammar) in this lane; left the three designer-parity
  tranches as captured for owner prioritization. Superseded the now-stale
  `explorer-record-kind-and-typed-manifest-2026-05-28.md` (its blocking contract
  gap was landed; its `apps/web` paths are dead).
