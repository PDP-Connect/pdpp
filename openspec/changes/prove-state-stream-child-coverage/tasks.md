## 1. Contract

- [x] Specify the `STREAM_EVIDENCE` message, its validation rules, and its
      non-interaction with checkpoint-commit eligibility.
- [x] Specify runtime folding of `STREAM_EVIDENCE` into
      `RuntimeCollectionFact` without touching `coherence.ts`,
      `connector-coverage-policy.ts`, or the eligible-checkpoint algorithm.
- [x] Validate the OpenSpec change strictly (`openspec validate
      prove-state-stream-child-coverage --strict`) — passes. `openspec
      validate --all --strict` holds at 119/130 (same baseline the reviewed
      proposal commit established; no new regressions).

## 2. Root protocol spec

- [x] Add `STREAM_EVIDENCE` to `spec-collection-profile.md` §3 (Connector to
      Runtime messages), including the field table, validation rules, and
      the TypeScript `ConnectorMessage` union member.
- [x] Add `STREAM_EVIDENCE` to the connector-conformance and
      runtime-conformance checklists (§4).
- [x] Cross-reference `STREAM_EVIDENCE` from the `DETAIL_COVERAGE` section's
      `state_stream` prohibition, so a reader hits the alternative
      immediately after reading why `DETAIL_COVERAGE` is closed off.
- [x] (Independent review round 1, P0-2) Removed RI-private identifiers
      (`missingDetailCoverageReports`, `recordDetailCoverageShortfalls`,
      "the classifying-run selector") from normative clauses; restated
      behaviorally ("MUST NOT affect any checkpoint stream's commit
      eligibility or any `DETAIL_COVERAGE` shortfall determination").
      Changed `runId` → `run_id` (the actual wire field name; `runId` was
      the internal RI camelCase variable) and cross-referenced `START`'s
      `run_id` field for rule 5's "same run" definition. Objective check:
      `grep -on '`[a-zA-Z_]*[a-z][A-Z][a-zA-Z_]*`' spec-collection-profile.md`
      → zero hits (was 6 before this fix).
- [x] (Independent review round 1, P1-6) Rewrote the Compatibility paragraph:
      it previously asserted, as protocol fact, that an unrecognized
      `msg.type` fails a run — that is a property of the reference
      implementation's runtime, not a profile requirement. Restated to say
      the profile does not require rejecting unknown types, and scoped the
      "fails the whole run" claim explicitly to runtimes sharing the
      reference implementation's fail-closed dispatch posture.
- [x] (Independent review round 1, P0-3) Added a "Coverage projection is out
      of scope for this section" note: the root protocol spec is
      deliberately wire-only and defines no portable v0.1 coverage-condition
      vocabulary for ANY stream shape (this was already true before
      `STREAM_EVIDENCE`; the gap was in leaving item 17's fold obligation
      standing without saying so). Added the one non-optional MUST NOT this
      section needs regardless of vocabulary choice: a runtime MUST NOT
      treat `covered < considered` as evidence of full coverage. Pointed to
      `openspec/specs/reference-implementation-runtime/` (pending archive of
      this change) as the actual normative home for the RI's own
      `partial`/`complete`/`retryable_gap` projection semantics — that
      capability spec delta already existed in this change directory
      (`specs/reference-implementation-runtime/spec.md`) but had not been
      cross-referenced from the wire spec.
- [x] (Independent review round 1, P1-3) Defined "genuine enumeration
      boundary" (a stream whose hydration lane actually ran its enumeration
      step this run, vs. one whose lane never ran) and explicitly marked
      both that clause and the `considered`-derivation-provenance clause as
      sender-side honesty obligations a runtime cannot observe or enforce on
      the wire — same quarantine pattern as the existing `optional_skip_keys`
      non-portable-extension note.

## 3. Runtime

- [x] Add `trackStreamEvidence(msg)`, parallel to `trackDetailCoverage`, with
      the five rejection rules from the `polyfill-runtime` spec delta.
      (`reference-implementation/runtime/index.ts`:
      `validateStreamEvidenceMessage`, `validateStreamEvidenceAgainstManifest`,
      `trackStreamEvidence`, `handleStreamEvidenceMessage`, wired into
      `protocolHandlers`.)
- [x] Fold accepted `STREAM_EVIDENCE` facts into `RuntimeCollectionFact` at
      the point `buildCollectionFacts` assembles the terminal collection
      report. (`reference-implementation/runtime/connector-gap-bounding.ts`:
      `streamEvidenceByStream` input + fallback fold in the `streams.map`.)
- [x] Add discriminating tests: clean coverage → `complete`; gapped keys →
      `retryable_gap`; unaccounted key (simulated swallowed exception,
      `covered < considered` with `pending_detail_gaps: 0`) → `partial`,
      never `complete`; no `STREAM_EVIDENCE` emitted → unchanged
      inheritance/`unknown`. (`reference-implementation/test/stream-evidence.test.ts`)
- [x] Add rejection tests for each of the five validation rules
      (`reference_only` not `true`; out-of-scope `stream`; non-`state_stream`
      stream shape; `covered > considered` or negative counts; duplicate
      per stream/run). (Independent review round 1, P1-2: the initial
      implementation's `reference_only`/out-of-scope rules were NOT actually
      tested — every fixture happened to set `reference_only: true` and
      stay in scope, so both mutations survived at 11/11 green. Added two
      dedicated tests: "STREAM_EVIDENCE with reference_only not true is
      rejected" and "STREAM_EVIDENCE naming a stream outside the run's scope
      is rejected." Both verified to flip red under their respective
      mutation and green after revert.)
- [x] Add a negative test proving `DETAIL_COVERAGE` naming a `state_stream`
      child is still rejected after this change ships.
- [ ] Add a test proving `STREAM_EVIDENCE` duplicate-rejection (rule 5) scopes
      to `run_id`, not to a logical/resumed collection spanning multiple
      `run_id`s: a second `STREAM_EVIDENCE` for the same stream under a new
      `run_id` (simulating a resumed or retried run) is accepted, not
      rejected as a duplicate of the prior `run_id`'s accepted fact. Still
      not covered. Independent review round 1 (P2-1) additionally found the
      prior tasks.md text overstated the mechanism: `streamEvidenceByStream`
      scopes duplicate-rejection by **Map object lifetime** (one Map per
      `runConnector` invocation), NOT by comparing a `run_id` field value the
      way `applyStateStreamCheckpointInheritance` compares
      `parent.runId === child.runId`. These coincide only if one
      `runConnector` invocation always corresponds to exactly one `run_id`,
      which is not guaranteed everywhere in the codebase (a retry path can
      reuse a `run_id` across separate `runConnector` invocations). Not a
      live safety issue today (STREAM_EVIDENCE gates nothing, so the
      divergence is at most more-permissive-than-spec, not less), but the
      spec's rule 5 and this file's own prior claim both describe a
      `run_id`-keyed mechanism the code does not implement. Left unresolved
      pending a decision: key `streamEvidenceByStream` by `run_id` explicitly
      to match the spec, or relax rule 5's wording to describe the weaker
      per-invocation guarantee actually shipped.
- [x] Add a negative test proving no code path lets accepting, rejecting, or
      omitting `STREAM_EVIDENCE` change any checkpoint's commit eligibility.
- [x] Add a regression test proving the read-model rule from design.md
      ("Survival of an accepted fact past a later run-level failure or
      cancel"): a run that accepts `STREAM_EVIDENCE{considered: n,
      covered: n}` for a `state_stream` child and then fails or is cancelled
      on an unrelated stream MUST NOT have that child's `complete`
      projection surfaced to the owner in place of `lastSuccessfulRun`'s (or
      `unknown`, if none) coverage for that stream — i.e. the runtime's
      existing run-selection policy, not `STREAM_EVIDENCE` acceptance,
      governs what the owner sees.
- [x] (Independent review round 1, P0-1) Fixed a shipped-code regression:
      `classify-runtime-failure.ts` carried no `STREAM_EVIDENCE` prefixes, so
      every `STREAM_EVIDENCE` rejection classified as the retryable
      `runtime_error` default instead of `connector_protocol_violation` — a
      deterministic protocol violation would have been retried forever by
      the scheduler and never attributed to the connector on the operator
      surface. The OLD runtime (predating this change) classified its own
      "unknown message type" rejection for the same wire event correctly;
      this change regressed that for the message it introduced. Fixed by
      adding the missing prefixes; added `failure_reason ===
      "connector_protocol_violation"` assertions to all five STREAM_EVIDENCE
      rejection tests (verified against the real classifier module, matching
      every distinct thrown message shape). Also found and fixed the same
      pre-existing classifier gap for `DETAIL_COVERAGE`'s `state_stream`-
      prohibition message (`"Connector emitted DETAIL_COVERAGE for stream
      '...' which the manifest declares with a static state_stream
      parent..."`), present on baseline `e05229aaf` before this change and
      exposed by the "DETAIL_COVERAGE naming a state_stream-declared stream
      is still rejected" test once it started asserting `failure_reason`.
- [x] (Independent review round 1, P1-1) Added
      `test/stream-evidence-flush-ordering.test.ts`, cloned from
      `detail-coverage-flush-ordering.test.ts`'s pattern: a real
      `runConnector` run against a real server, a connector that emits
      records then `STREAM_EVIDENCE` then dies without `DONE`, asserting (a)
      the records are durable in the record store despite no end-of-run
      flush, and (b) the spine proves ordering —
      `run.batch_ingested.event_seq < run.stream_evidence_declared.event_seq`.
      Verified: deleting `await flushAll()` from `handleStreamEvidenceMessage`
      flips this test red (previously undetected — the full 11-test suite
      stayed green with that flush removed).

## 3a. Rollout ordering (see design.md "Compatibility and versioning")

- [x] This change ships the runtime side only (`STREAM_EVIDENCE` added to
      `protocolHandlers`). No connector in this repository emits
      `STREAM_EVIDENCE` yet — Gmail's `message_bodies` measurement is
      explicitly out of scope for this change (see Residual Risk in
      design.md) and MUST land as a separate, later follow-up, deployed only
      after this runtime change is live everywhere that will run it.
- [ ] (Independent review round 1, P1-5) Track the cross-repo blocker on the
      connector-side follow-up: `vendor/pdpp-connector-protocol-0.0.1.tgz`'s
      `EmittedMessage` union (which types `ctx.emit` for every connector) and
      `packages/polyfill-connectors/connectors/gmail/types.ts` both predate
      `STREAM_EVIDENCE` and contain zero references to it. No connector in
      this monorepo can emit `STREAM_EVIDENCE` and typecheck until the
      upstream `PDP-Connect/data-connect` repo ships a tarball that includes
      it and this repo re-pins to that version. Not a defect in this change
      (consistent with, and in fact enforcing, runtime-first rollout) but
      previously untracked anywhere. This item is the tracking record; the
      connector-evidence follow-up change must not be scheduled as
      unblocked until the tarball is re-pinned.

## 4. Mutation checks

Run against this lane's implementation (`reference-implementation/runtime/`):

- [x] Deleted the `trackStreamEvidence` fold body (no-op) → the clean-pass,
      swallowed-exception, duplicate, commit-gating, and DETAIL_GAP mutation
      tests all went red (5/13 tests failed). Reverted.
- [x] Disabled the `covered > considered` rejection (rule 4) → exactly
      "STREAM_EVIDENCE with covered greater than considered is rejected"
      went red, no other test affected. Reverted.
- [x] Deleted the `state_stream`-shape check in
      `validateStreamEvidenceAgainstManifest` → exactly the
      parent_streams-rejection and self-mapped-rejection tests went red.
      Reverted.
- [x] Disabled the duplicate-rejection check (rule 5) → exactly the
      duplicate-STREAM_EVIDENCE test went red. Reverted.
- [x] (Independent review round 1) Deleted `await flushAll()` in
      `handleStreamEvidenceMessage` → the new flush-ordering test went red
      (previously: no test detected this; whole suite stayed green).
      Reverted.
- [x] (Independent review round 1) Disabled the `reference_only !== true`
      check → exactly the new `reference_only` test went red (previously:
      no test detected this). Reverted.
- [x] (Independent review round 1) Removed the `validateOptionalScopedStream`
      call for `STREAM_EVIDENCE` → exactly the new out-of-scope test went
      red (previously: no test detected this; security-adjacent, since this
      is the guard stopping a connector reporting coverage about a stream
      the owner did not select for the run). Reverted.
- [ ] Enumeration-site push / boundary-predicate mutations (tasks.md's
      original §4 items 1-3) are connector-side (Gmail `message_bodies`
      measurement code, not yet written) and remain for the follow-up
      connector-evidence change.

## 5. Verification

- [x] Run focused lint, typecheck, connector, and runtime tests.
      `pnpm --dir reference-implementation run typecheck` — clean except one
      pre-existing, unrelated failure in
      `test/ref-connectors-local-coverage-green.test.ts` (confirmed present
      on unmodified baseline). `ultracite check` on the changed files —
      clean except pre-existing baseline findings unrelated to this change
      (confirmed present on unmodified baseline; left untouched to keep the
      diff scoped to this change).
- [x] Run the focused connector and runtime regression suites (counts
      corrected per independent review round 1, P2-2/P2-3 — see below):
      `test/stream-evidence.test.ts` (13/13),
      `test/stream-evidence-flush-ordering.test.ts` (1/1),
      `test/collection-report-projection.test.ts`,
      `test/collection-profile.test.ts`,
      `test/checkpoint-dependency-profile-conformance.test.ts`,
      `test/detail-coverage-flush-ordering.test.ts`,
      `test/detail-coverage-recovered-gap-regression.test.ts`,
      `test/detail-coverage-shortfall-severity.test.ts`,
      `test/connector-summary-stream-facts.test.ts`,
      `test/connector-coverage-policy.test.ts`,
      `test/connector-gap-bounding-recovery-only-facts.test.ts`,
      `test/ri-zero-connector-knowledge-conformance.test.ts` (94/94 — the
      required CI guard for touching `reference-implementation/runtime/`;
      this guard was not run or mentioned in the round-1 commit message,
      per independent review) — 0 failures across the full set.
- [x] Independent checker verdict obtained on the round-1 implementation
      diff: REVISE, with 3 P0s, 7 P1s, 9 P2s. This tasks.md revision and the
      accompanying commit address every item in the review's "Minimum to
      reach SHIP" list (P0-1, P0-2, P0-3, P1-1, P1-2, P1-3, P1-7) plus the
      P2 count/claim corrections. The review's own remaining P1/P2 items not
      in the "Minimum to reach SHIP" list (P1-4 recovery-only path, P1-5
      tracked above, P2-1 run_id-vs-lifetime divergence tracked above,
      P2-5/P2-6/P2-8/P2-9 documentation-precision items, and the
      `connector-summary-read-model.ts` recovery-gap-closure downstream
      interaction) are acknowledged here as open and NOT independently
      re-verified by a second reviewer in this round — see the round-2
      report for exact disposition.

This change ships runtime/protocol support only, per the required rollout
order (design.md "Compatibility and versioning"): the runtime accepts and
folds `STREAM_EVIDENCE` but no connector in this repository emits it yet.
Gmail's `message_bodies` measurement (the connector-evidence half) is a
separate follow-up change, to be deployed only after this one is live, and
is additionally blocked on a vendored-protocol-tarball re-pin (see §3a).
