## Why

The connector→runtime protocol types a checkpoint payload as `cursor: unknown`
(`packages/polyfill-connectors/src/connector-runtime-protocol.ts`), and the
runtime's complete validation of it is that it is a non-array object or null.
The runtime therefore has zero information with which to tell a safe cursor
from an unsafe one, and `commit_on_success` is what that absence of information
forces — a no-information fallback, not a risk judgment.

The cost is measured on the live spine: fleet-wide, 130,517 `run.state_staged`
against 75,513 `run.state_advanced`, so 42% of staged checkpoint work is
discarded. Restricting to terminal runs that staged at least one stream and
reported `checkpoint_commit_status = not_committed`, 465 runs across 14
connectors durably ingested 897,916 records and advanced no cursor.

Today, cursor safety is not a property of the cursor. It is a property of when
a connector happens to emit. `heb` `orders` sets `newestOrderDate` from page 1
before the older pages are walked, and is safe only because its single
`emit({ type: "STATE" ... })` sits after `runForwardScan` returns. Move that
emit inside the loop and it becomes permanent data loss, with no runtime check
firing and no test failing. That is an unowned invariant held in place by code
review alone.

This change writes down the contract that lets a connector *say* whether its
checkpoint is safe, and lets the runtime check that claim against a fact the
runtime itself wrote.

## What Changes

This change is a **qualification standard**, not a migration plan. It defines
what a connector must be able to express to earn incremental commit, and
accepts that most of the fleet will never express it.

- Define an optional `checkpoint_claim` on the `STATE` message carrying a
  declared identifier space with an epoch, a set of **covered intervals** over
  that space, and an optional partition key. Outstanding debt is **derived from
  the gaps** between covered intervals; it is never separately declared, so the
  two cannot disagree.
- Define the runtime's connector-agnostic decision procedure. Absent claim,
  mismatched epoch, or a claim advancing with no durably ingested records this
  run ⇒ stage only. A partition-scoped claim moving any other partition's
  position ⇒ protocol violation.
- Define **claim granularity**. A claim's interval endpoints are positions in a
  declared space at a declared granularity. A coarse granularity (a day) is a
  truthful claim when a finer one is not expressible, provided the connector
  can prove every item in that coarse unit was accounted for.
- Record the qualification results for the three prototyped connectors as
  evidence that the qualifier discriminates: `gmail` qualifies, `slack` is
  disqualified at every granularity, and `heb` qualifies **only** at day
  granularity and **only** under a closed-day rule this change specifies.
- Adopt an ideal-compatibility rule constraining every later fix on this
  program: no new health logic reading evidence projections, no new implicit
  run-state flags, no new cursor shapes violating the claim schema.

Non-qualifying connectors keep `commit_on_success` unchanged and forever. That
is a correct permanent answer, not a temporary one.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: Define the checkpoint claim's covered-intervals
  representation, the identifier-space epoch, claim granularity and the
  closed-unit rule, the runtime's commit decision procedure, the
  disqualification criteria, and the ideal-compatibility rule.

## Impact

- No production code changes in this tranche. This change is the qualification
  standard; implementation is sequenced behind it.
- When implemented: `packages/polyfill-connectors/src/connector-runtime-protocol.ts`
  gains an optional field, and `reference-implementation/runtime/index.ts`
  gains the decision procedure at its `STATE` handler. Both are additive — a
  connector that says nothing keeps today's behavior exactly.
- The representation is deliberately storage-free, so a later compaction or
  interval-store layer is an additive migration rather than a rewrite.

## Non-Goals

- **Fleet-wide adoption.** Explicitly not a goal. A connector whose runs take
  40 seconds should redo its run; buying the contract there is cost with no
  benefit. The contract is bought only where interruption pain is real, which
  the live measurement localizes to a handful of connectors.
- **A storage or compaction layer for intervals.** This change specifies the
  representation only. How intervals are stored, merged, or bounded is left
  open so the terminal form is an additive migration.
- **Committing staged cursors under an `INTERRUPTED` terminal state.** That
  remains gated on the sibling change
  `adjudicate-interrupted-runs-by-owner-epoch`, whose measurement stands: zero
  of 34,928 `run.detail_coverage_declared` events carry `boundary`,
  `slice_start`, or `slice_end`.
- **Rescuing `slack`.** No granularity coarsening makes an unordered scan
  claimable. Slack needs an ordered scan first; that is separate work.
- **Any per-connector allowlist.** If one becomes necessary, the contract has
  failed — the claim is meant to travel with the data.

## Residual risks

- The `heb` day-granularity verdict is derived from source reading, not from a
  live run. `heb` sign-in costs the owner a real OTP, so live confirmation is
  deferred rather than performed. The closed-day rule is written to fail closed,
  so a wrong reading withholds a commit rather than losing data.
