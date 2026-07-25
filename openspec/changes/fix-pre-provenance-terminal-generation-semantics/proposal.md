## Why

`reconcile-active-summary-evidence` (shipped in `d2238287`) added a
generation-provenance gate to the terminal-facts fold: a stamped
`manifest_generation` must equal the connection's current durable generation
or the event is refused as historical. The gate is correct for its intended
case (a genuine manifest transition must not let old-generation facts pass as
current) but it is stricter than the spec's own migration guarantee for one
case it did not anticipate: the trigger that stamps `manifest_generation`
(`stamp_terminal_manifest_generation`) is itself new in `d2238287`, so every
terminal event appended before that deploy carries `manifest_generation IS
NULL`. The gate treats NULL as "not the current generation" unconditionally,
so it refuses ALL pre-deploy terminal history, even for connections whose
generation has never advanced past 0 (the only generation such history could
possibly belong to). `reconcile-active-summary-evidence`'s own migration
(2.7) anticipated exactly this ambiguity and deliberately chose not to
fabricate provenance — but the fold's read-time interpretation of NULL is
strictly more conservative than necessary: a connection that has never
advanced past generation 0 has no other generation its unstamped history
could belong to.

Post-deploy live verification (2026-07-21) surfaced a second, distinct,
pre-existing defect that produces the identical symptom
(`runtime_evidence_missing`) once Fix A/B above are live: the Collection
Report's read-side overlay in `ref-control.ts`
(`resolveEffectiveStreamFacts`) lets a classifying run's own per-stream fact
shadow the durable latest-attempt store even when the classifying run's fact
does not itself prove durable coverage and the stored fact already does. Both
ChatGPT connections' most recent terminal run is a `run.failed` whose own
facts read `not_staged` for all six streams (the run failed before
attempting them); the durable store, healed by Fix A, already holds
`committed` checkpoints for all six from the last succeeded run. The
classifying run's `not_staged` facts shadow the stored `committed` facts, so
the served report reads `unknown`/`unmeasured` even though the store itself
reads `complete`. This is the exact "connection-health `runtime_evidence_missing`
defect class" the fold's own monotonicity guard
(`mergeEventStreamFacts`) already defends against at the store layer — the
guard is simply missing at this second, read-side site.

Live verified impact (2026-07-21, read-only, `pdpp` Postgres): 10 of 14
active connections showing `terminal_facts_reason_code =
terminal_facts_historical` have `manifest_generation = 0` (never advanced)
and real, attributable, durably-committed terminal evidence
(`checkpoint="committed"`) that the fold refuses solely because of the NULL
stamp. Two of the three connections in question (ChatGPT) cannot currently
run new collections at all (legitimately gated on pending owner browser
reauth — unrelated and out of scope), so they have no path to ever mint a
stamped replacement; the third (Gmail) can run new collections, but a second,
independent defect compounds the first: `resolveRecoveryFirstMode`'s
implicit-unscoped branch has no forward bound, so an existing non-pressure
recovery backlog can keep winning every tick indefinitely (live: Gmail's last
fact-carrying forward run was 5+ days and ~640 runs ago; recovery-only won
every tick since). Together the two defects can make a healthy, actively
collecting connection report false `terminal_facts_historical` /
`runtime_evidence_missing` indefinitely, with no owner action and no code
change able to self-heal it.

## What Changes

1. **Fold NULL-generation semantics (Fix A).** An attributable terminal
   event with no stamped `manifest_generation` is consumed as
   current-generation evidence **if and only if** the connection's durable
   generation has never advanced past 0. The moment a connection's
   generation advances to >= 1, its NULL rows become permanently ambiguous
   (they could predate or postdate any earlier untracked manifest change)
   and remain historical forever, exactly as today. Mismatched non-NULL
   stamps and unattributable (no single connection) events are unaffected —
   they remain refused. This is a read-time interpretation change only; no
   spine_events backfill, no data migration.
2. **Fold-contract version replay.** `STREAM_FACTS_FOLD_LOGIC_VERSION` bumps
   from 3 to 4 so every stored terminal map — including rows already
   `current` under the old (stricter) semantics — replays its full
   attributable history under the new acceptance rule via the existing
   version-behind self-heal machinery. No per-row repair, no manual
   intervention; the very next observation of each row performs the replay.
3. **Forward-evidence-debt bound on recovery-first selection (Fix B).**
   `resolveRecoveryFirstMode`'s implicit-unscoped branch gains one
   additional input, `forwardEvidenceDebt`. When true, non-pressure recovery
   eligibility no longer wins the tick — a forward (fact-carrying) run is
   selected instead, clearing the debt and (via Fix A/the fold's
   last-writer-wins semantics) flipping the connection's terminal facts back
   to current. Explicit `requestedRecoveryOnly` and `scopedToResources`
   precedence are unchanged: an explicit choice or a scoped run is never
   overridden by the debt bound. Debt is defined connector-neutrally from
   existing evidence: the connection's terminal facts are not `current`, or
   its newest folded fact's `evidence_as_of` is older than
   `FORWARD_EVIDENCE_MAX_AGE`. Consumed at both existing recovery-first
   seams: the scheduler dispatch governor
   (`runtime/scheduler/dispatch-governor.ts`) and the controller's
   `resolveEffectiveRecoveryOnly` (`runtime/controller.ts`).
4. `FORWARD_EVIDENCE_MAX_AGE` is grounded in the connector's own schedule
   interval already threaded through the scheduler seam
   (`scheduleIntervalMs`, normalized by `normalizeScheduleIntervalMs`) rather
   than inventing a new, disconnected governor: `max(4 * scheduleIntervalMs,
   1h)`. No existing normative contract defines a numeric schedule-interval
   multiplier for evidence staleness (the freshness-strategy spec in
   `define-stream-coverage-freshness-evidence` defines the freshness AXIS but
   not a numeric bound), so this is a new, explicit, documented policy
   constant scoped to this one predicate — not a reinterpretation of an
   existing one. Any bounded bound closes the underlying defect; this value
   is chosen to be comfortably wider than ordinary cadence jitter/backoff so
   it never fires under normal operation, while still being finite.
5. **Read-side monotonic durable-proof floor for the Collection Report
   overlay (Fix C).** `resolveEffectiveStreamFacts`
   (`reference-implementation/server/ref-control.ts`) gains the same
   monotonicity guard the store-layer fold (`mergeEventStreamFacts`) already
   enforces: a classifying run's own per-stream fact may shadow the durable
   latest-attempt store's fact for that stream **unless** the stored fact
   proves durable coverage (`checkpoint` is `committed` or `disabled`) and
   the classifying run's own fact for that same stream does not — in that
   case the stored fact and its own provenance (`evidence_as_of`, `run_id`)
   are kept instead of being shadowed. A classifying fact that itself proves
   durable coverage still replaces the stored fact normally (forward
   progress unaffected); a stream with no durably-proven stored fact is
   unaffected by the floor (a never-proven stream keeps surfacing its
   newest, possibly unresolved, classifying attempt). This reuses the
   existing `checkpointProvesStreamCoverage` boundary already defined in
   `ref-control.ts` rather than inventing a new or divergent predicate — the
   same boundary `mergeEventStreamFacts`'s guard and
   `connector-coverage-policy.ts`'s `checkpointProvesCoverage` already use.
   Read-side only; no data, schedule, or store-layer change.

## Impact

- Affected specs: `reference-connector-instances` (MODIFIED: manifest
  generation transition requirement; ADDED: Collection Report read-side
  monotonic durable-proof floor), `reference-implementation-runtime` (ADDED:
  recovery-first forward-evidence-debt bound).
- Affected code: `reference-implementation/server/connector-summary-read-model.ts`
  (fold gate + fold-logic version), `reference-implementation/server/ref-control.ts`
  (`resolveEffectiveStreamFacts` read-side floor), `reference-implementation/server/connector-coverage-policy.ts`
  (defensive `considered` denominator normalization — incidental, latent, unreachable via the typed
  read path), `reference-implementation/runtime/recovery-decision.ts`
  (shared policy + debt predicate + `FORWARD_EVIDENCE_MAX_AGE`),
  `reference-implementation/runtime/scheduler/dispatch-governor.ts` and
  `reference-implementation/runtime/controller.ts` (consume the new input),
  plus their durable-evidence-read wiring in `server/scheduler-manager-factory.js`
  and `server/index.js`.
- No spine_events backfill, no manual runs, no owner action, no data
  migration. Repair is the deploy itself: the existing reconcile-before-read
  barrier replays every version-behind row on its next observation; the
  read-side floor takes effect on the very next `/_ref/connectors` read with
  no fold replay needed (it does not change stored data or the fold-logic
  version).
- Rollback is a plain revert: an older binary sees `stream_facts_fold_version
  = 4` rows as fold-logic-version-AHEAD and serves them read-only without
  re-folding or overwriting — no corruption, no flapping. The read-side floor
  reverts with the same commit revert; no data was mutated by it either way.
