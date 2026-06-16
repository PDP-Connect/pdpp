## Why

The reference connection-health projection (`connection-health.ts`, 2679 lines)
is honest: it deliberately splits the headline `state` from orthogonal coverage /
freshness / attention / outbox axes so a green pill can carry a separate freshness
truth. Three verified failures persist, each grounded in a live connector on
`pdpp.vivid.fish` (re-run against Postgres on 2026-06-15):

1. **Contradictory and dishonest signals reach the screen.** Every owner surface
   re-derives the verdict from `health.state` alone and drops the co-required
   axes. Amazon (`state:healthy`, `axes.freshness:stale`, no schedule) renders a
   green "Required coverage is current and complete." headline; a per-stream chip
   prints the arithmetically impossible "3/2 collected"; another prints
   "coverage·unknown · resumes collection" — two facts that cannot both be true.
   Each formatter is individually tested and individually defensible; nothing
   asserts the composite is consistent, so the lies ship one PR at a time.

2. **There is no recovery model.** `next_action` is a CTA string, not a typed
   required action with a satisfaction condition, a terminal flag, or an
   auto-resume contract. The system can name a problem but cannot prove it is
   solved or drive itself back to green. Chase emits the same "resumes collection"
   disposition for a recoverable QFX gap and would emit it for a terminal selector
   gap; the next run fails identically. "Then it should just work" was never built.

3. **Honesty without usefulness is still useless.** ChatGPT has 2,532 detail gaps
   that are 100% `recovered` (0 pending, live-confirmed) — the system already
   drained them and the owner can do nothing to accelerate a finished drain.
   Surfacing "2,532 gaps" is honest and useless; it trains the owner to ignore the
   dashboard. The one genuinely owner-actionable live state is Amazon (manual,
   31 days stale, nothing scheduled). The system must ACT silently where it holds
   the means (retry, refresh-token, drain) and interrupt the owner ONLY when the
   owner is the sole resolution.

Prior art (Plaid Item lifecycle + update-mode, Stripe tiered requirements, Nango /
Google silent refresh, Temporal runtime-vs-workflow, Google SRE alerting,
Weiser & Brown / Amber Case calm technology) converges on one shape: ONE
synthesized verdict rendered verbatim; a typed required-action with a satisfaction
contract and a self-heal loop; and a silence discipline that routes self-handled
signals to an inspection layer instead of the attention channel. The converged,
buildable-from design is
`docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` (folding
`slvp-connector-agency-and-silence-2026-06-15.md` into
`slvp-connector-health-ideal-design-2026-06-15.md`, diagnosed in
`slvp-connector-health-legibility-reflection-2026-06-15.md`, with prior art in
`slvp-connector-health-priorart-2026-06-15.md`).

## What Changes

- Add a single server-owned pure function `synthesizeRenderedVerdict(snapshot,
  streams, refresh) -> RenderedVerdict` next to the projection in
  `reference-implementation/runtime/rendered-verdict.ts`, forwarded verbatim
  through `ref-control.ts` -> `ref-client.ts` exactly as `connection_health` is
  today. It is the ONLY health object owner surfaces render; no surface reads
  `health.state`.
- Make `pill.tone` a worst-wins rollup of state + axes (never a straight read of
  `state`) and enforce render-time honesty invariants as a gate: freshness
  annotation mandatory off-fresh, `collected <= considered`, `forward_statement`
  reconciled with disposition + actions, `terminal` derived from disposition,
  label<->tone bijection.
- Add a `channel` field (`calm` / `advisory` / `attention`) computed by the same
  synthesizer AFTER `tone` — the attention-vs-inspection routing decision. Enforce
  silence invariants: no actionless signal in the attention channel; no
  mechanistic counts (gap / retry / backlog) on calm/advisory dashboard
  annotations; suppressed signals route to the inspection-layer `detail`, never to
  nothing; runtime faults do not cascade as per-connection attention pulls.
- Promote `next_action` to typed `RequiredAction[]` with `audience`, `urgency`,
  `affects[]`, `cta`, `terminal` DERIVED from `forward_disposition`, ONE unified
  `satisfied_when` (`SatisfactionContract` discriminated union), and a `wait` kind
  that is the single home for self-handled drain / source-pressure cooldown /
  in-flight syncing.
- Define a self-heal / auto-resume loop: a `satisfied_when` watcher in the
  connection controller detects the durable-evidence flip and automatically
  re-attaches the schedule, fires ONE confirming run, drains recoverable gaps,
  re-synthesizes, and flips green — with no separate "now run it" step, landing on
  the EXISTING connection (schedule + tokens survive). Identical re-failure
  re-presents the same action with the reason (no false green).
- Reaffirm a refresh-contract creation invariant (account => declared refresh
  contract from the manifest, NOT account => credential — ChatGPT is account +
  scheduled + zero credentials) and route manual-refresh-stale connections to an
  owner-refresh advisory while keeping collection health separate from freshness.
- Add a collection-model-aware `RenderedProgress` (records committed + gaps
  drained) replacing `records_emitted` as the productivity signal, and split the
  owner dashboard (attention layer) from the full-fidelity `detail` panel
  (inspection layer) so mechanistic numbers — including the 2,532 gaps — render
  only in `detail`.

## Capabilities

Modified:
- `reference-connection-health`
- `reference-connector-instances`

Added:
- None.

Removed:
- None.

## Impact

- No PDPP Core change; grant-scoped reads are unaffected. `RenderedVerdict` and
  its inspection-layer `detail` (gap backlog, drain rate, scheduler state,
  collection rate, raw disposition) remain owner-only diagnostics and SHALL NOT be
  exposed to grant-scoped clients, identical to the existing `detail_gap_backlog`
  policy.
- Strictly additive on `connection-health.ts`: a synthesis layer, one promoted
  field family (`RequiredAction[]`), a recovery loop, and a routing field. The
  2679-line projection is not rewritten; `deriveForwardDisposition`
  (`connection-health.ts:2111`) remains the sole terminality oracle, and the
  existing `isHealthRelevant`, info-severity `stale_assisted_refresh`, and
  `pushPayload(owner_action:"none") -> null` decisions are lifted into the one
  `channel` predicate rather than duplicated.
- The highest-leverage unverified link (the design's Risk 1) is that
  manual-refresh evidence (`ConnectionRefreshEvidence`) actually reaches the
  projection for amazon / chase / reddit / usaa at runtime; if null, manual-stale
  falls through to `complete` and stays green. The refresh-contract task must
  verify the runtime input, not just the manifest.
- The terminal / `code_fix` channel-as-status path has no live instance (zero
  terminal gaps live); it is covered by synthetic fixtures until a real
  stale-selector failure exercises it.
- This change supersedes the parked sibling change `synthesize-connector-health-
  verdict`, which proposed the same synthesizer from the honesty-first framing
  before the recovery-and-agency half was fully specified. The two SHALL NOT both
  be implemented; this change is the complete successor.
