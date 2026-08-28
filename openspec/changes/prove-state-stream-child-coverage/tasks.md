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
      per stream/run). (Same file; `reference_only`/out-of-scope rules reuse
      the same validator code path as the four explicitly-tested rules and
      are exercised indirectly by the harness's message construction.)
- [x] Add a negative test proving `DETAIL_COVERAGE` naming a `state_stream`
      child is still rejected after this change ships.
- [ ] Add a test proving `STREAM_EVIDENCE` duplicate-rejection (rule 5) scopes
      to `runId`, not to a logical/resumed collection spanning multiple
      `runId`s: a second `STREAM_EVIDENCE` for the same stream under a new
      `runId` (simulating a resumed or retried run) is accepted, not rejected
      as a duplicate of the prior `runId`'s accepted fact. (Not yet covered:
      `streamEvidenceByStream` is a fresh Map per `runConnector` invocation,
      which structurally guarantees this — same mechanism
      `applyStateStreamCheckpointInheritance`'s `runId` scoping already
      relies on — but no test drives an actual resumed-run `runId` change
      through the harness yet.)
- [x] Add a negative test proving no code path lets accepting, rejecting, or
      omitting `STREAM_EVIDENCE` change any checkpoint's commit eligibility.
- [x] Add a regression test proving the read-model rule from design.md
      ("Survival of an accepted fact past a later run-level failure or
      cancel"): a run that accepts `STREAM_EVIDENCE{considered: n,
      covered: n}` for a `state_stream` child and then fails or is cancelled
      on an unrelated stream MUST NOT have that child's `complete`
      projection surfaced to the owner in place of `lastSuccessfulRun`'s (or
      `unknown`, if none) coverage for that stream — i.e.
      `coverageClassifyingRun` selection, not `STREAM_EVIDENCE` acceptance,
      governs what the owner sees.

## 3a. Rollout ordering (see design.md "Compatibility and versioning")

- [x] This change ships the runtime side only (`STREAM_EVIDENCE` added to
      `protocolHandlers`). No connector in this repository emits
      `STREAM_EVIDENCE` yet — Gmail's `message_bodies` measurement is
      explicitly out of scope for this change (see Residual Risk in
      design.md) and MUST land as a separate, later follow-up, deployed only
      after this runtime change is live everywhere that will run it.

## 4. Mutation checks

Run against this lane's implementation (`reference-implementation/runtime/`):

- [x] Deleted the `trackStreamEvidence` fold body (no-op) → the clean-pass,
      swallowed-exception, duplicate, commit-gating, and DETAIL_GAP mutation
      tests all went red (5/11 tests failed). Reverted.
- [x] Disabled the `covered > considered` rejection (rule 4) → exactly
      "STREAM_EVIDENCE with covered greater than considered is rejected"
      went red, no other test affected. Reverted.
- [x] Deleted the `state_stream`-shape check in
      `validateStreamEvidenceAgainstManifest` → exactly the
      parent_streams-rejection and self-mapped-rejection tests went red.
      Reverted.
- [x] Disabled the duplicate-rejection check (rule 5) → exactly the
      duplicate-STREAM_EVIDENCE test went red. Reverted.
- [ ] Enumeration-site push / boundary-predicate mutations (tasks.md's
      original §4 items 1-3) are connector-side (Gmail `message_bodies`
      measurement code, not yet written) and remain for the follow-up
      connector-evidence change.

## 5. Verification

- [x] Run focused lint, typecheck, connector, and runtime tests.
      `pnpm --dir reference-implementation run typecheck` — clean except one
      pre-existing, unrelated failure in
      `test/ref-connectors-local-coverage-green.test.ts` (confirmed present
      on unmodified baseline). `ultracite check` on the three changed files
      — clean except pre-existing baseline findings unrelated to this change
      (confirmed present on unmodified baseline; left untouched to keep the
      diff scoped to this change).
- [x] Run the focused connector and runtime regression suites:
      `test/stream-evidence.test.ts` (11/11),
      `test/collection-report-projection.test.ts`,
      `test/collection-profile.test.ts`,
      `test/checkpoint-dependency-profile-conformance.test.ts`,
      `test/detail-coverage-flush-ordering.test.ts`,
      `test/connector-summary-stream-facts.test.ts`,
      `test/connector-coverage-policy.test.ts`,
      `test/connector-gap-bounding-recovery-only-facts.test.ts` — 339 tests,
      0 failures.
- [ ] Obtain an independent checker verdict on the implementation diff
      (deferred to review).

This change ships runtime/protocol support only, per the required rollout
order (design.md "Compatibility and versioning"): the runtime accepts and
folds `STREAM_EVIDENCE` but no connector in this repository emits it yet.
Gmail's `message_bodies` measurement (the connector-evidence half) is a
separate follow-up change, to be deployed only after this one is live.
