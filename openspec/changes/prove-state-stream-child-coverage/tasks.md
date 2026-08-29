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
      stream shape; `covered > considered` or negative counts [this rule was
      later superseded by the `outcomes` sum-check in P1-2 §6; this bullet
      describes round-1 history accurately for what round 1 tested, not the
      current wire shape]; duplicate per stream/run). (Independent review
      round 1, P1-2: the initial
      implementation's `reference_only`/out-of-scope rules were NOT actually
      tested — every fixture happened to set `reference_only: true` and
      stay in scope, so both mutations survived at 11/11 green. Added two
      dedicated tests: "STREAM_EVIDENCE with reference_only not true is
      rejected" and "STREAM_EVIDENCE naming a stream outside the run's scope
      is rejected." Both verified to flip red under their respective
      mutation and green after revert.)
- [x] Add a negative test proving `DETAIL_COVERAGE` naming a `state_stream`
      child is still rejected after this change ships.
- [x] **SUPERSEDED (P1-2 round 2 → round 3/4 corrected).** Round 2's
      entry here (below, struck through) described the per-invocation
      `streamEvidenceByStream` Map as a "narrower-but-safe" mechanism and
      left the same-`run_id`-across-invocations test unwritten. Independent
      re-review (round 3) correctly rejected that framing: a mechanism that
      ACCEPTS a duplicate the root profile requires REJECTED is more
      permissive, not narrower, and is a real gap, not a documentation
      choice. Round 3 closed it for real: added
      `streamEvidenceSeenByRunId`, a cross-invocation registry checked
      alongside the per-invocation Map (see `runtime/index.ts`), and wrote
      the previously-unwritten test
      ("STREAM_EVIDENCE: a second accepted fact for the same stream under
      the SAME run_id, across two separate runConnector invocations, is
      rejected", `test/stream-evidence-accepted-keys.test.ts`). A second
      independent review round (exact-head re-review) then found round 3's
      registry FIFO-capped at 10,000 entries, which silently loses the
      uniqueness guarantee once a long-lived process crosses that count —
      "raising the cap only delays the failure; it does not remove it."
      Round 4 first removed the eviction mechanism (a plain, non-evicting
      in-process Map), but a THIRD independent review pass correctly found
      that fix still incomplete: an in-process Map, evicting or not, loses
      the fact on process restart, while root profile rule 5 defines "same
      run" strictly by `run_id` and grants no restart exception. Round 4's
      final revision replaced the in-process registry with a durable store
      (`server/stores/stream-evidence-run-registry-store.ts`, backing table
      `stream_evidence_run_registry`, primary key EXACTLY `(run_id, stream)`
      matching rule 5's own scope) that survives a process restart, using a
      single atomic claim operation (`claimStreamEvidenceForRunId`,
      insert-and-report-whether-this-call-won) rather than a separate
      check-then-mark pair, which independent review also correctly flagged
      as a TOCTOU race under concurrent invocations. Three regression
      oracles now cover this: the never-evicts test
      ("STREAM_EVIDENCE: the cross-invocation run_id registry never
      evicts..."), a durability test proving a claim survives a
      `closeDb()`/`initDb()` cycle standing in for a process restart, and a
      concurrency test proving exactly one of 8 concurrent claims for the
      same `(run_id, stream)` wins
      (`test/stream-evidence-run-registry-store.test.ts`) — this is now a
      fully resolved item, not an open one.
      ~~Rather than re-architecting `streamEvidenceByStream` to key on the
      wire `run_id` field (the larger fix), relaxed the spec wording to
      state the guarantee the root protocol requires — "at most one
      accepted `STREAM_EVIDENCE` per stream per `run_id`" — without
      prescribing the mechanism, and documented the reference
      implementation's actual, narrower-but-safe mechanism
      (Map-object-lifetime, one Map per `runConnector` invocation)
      explicitly in `specs/polyfill-runtime/spec.md`, including why the
      narrower guarantee does not violate the broader one.
      `spec-collection-profile.md` rule 5 now states runtimes MAY implement
      the same-`run_id` scoping by any provably-equivalent mechanism.
      Independent review round 1's originally proposed test (duplicate
      rejection scoped to `run_id` across a simulated resumed/retried
      collection with the SAME `run_id` reused across two `runConnector`
      invocations) remains unwritten — it would require constructing a
      resumed-run harness this test suite does not otherwise exercise, and
      the spec no longer claims a guarantee that test would be proving;
      left as optional future work, not a blocking item, since the current
      mechanism cannot under-count (it is stricter, not looser, than
      required in every case except the documented more-permissive edge,
      which is safe by construction.)~~
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
      went red, no other test affected. Reverted. [Round-1 history: this
      rule and test were later superseded by the `outcomes` sum-check
      (P1-2 §6) and the mismatch/gapped-mismatch equality checks (P1-2 §7,
      round 2/3); see those sections for the current mutation-check log.]
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

## 6. P1-2: explicit outcomes partition (supersedes scalar `covered`)

An independent hostile design review
(`STREAM-EVIDENCE-TERMINAL-DESIGN-REVIEW.md §10`) found the P1-1 scalar
`covered` field structurally unable to close intra-run duplicate-key
inflation or claims of coverage over RS-rejected records, because `covered`
legitimately mixes writes with non-writes (suppressed-unchanged, gapped) —
a distinct-key count cannot be compared against a number that includes
non-writes. This section tracks the corrected implementation.

- [x] Replace wire `covered` with an explicit, sum-checked
      `outcomes: {emitted, unchanged, gapped, unaccounted}` partition.
      `spec-collection-profile.md` (both its prose field table and its
      illustrative `ConnectorMessage` TypeScript code fence) and both spec
      deltas in this change directory updated to match. `emitted +
      unchanged + gapped + unaccounted MUST equal considered` is now the
      rule-4 validation (previously `covered <= considered`). Independent
      review (round 2) correctly found `scripts/ci-mode.ts` was never
      touched and has no ambient `ConnectorMessage`/`STREAM_EVIDENCE` type
      at all — the prior revision of this line named the wrong file; the
      code fence actually edited lives in `spec-collection-profile.md`
      itself. Corrected here.
- [x] Add a parent-owned, lazy, per-run, disk-backed exact distinct
      `(stream, key)` set (`createAcceptedKeysStore` /
      `reference-implementation/runtime/index.ts`), populated only from
      `readIngestResponse`'s validated survivors (submitted batch minus the
      index-exact `rejections` vector) after the envelope contract check —
      never from the connector's own claims, never before the drift-skip
      and terminal-stop early returns in `flushBatch`. `INSERT OR IGNORE`
      on `PRIMARY KEY (stream, key)` makes a retried batch's re-POST a
      no-op rather than double-counting. No cross-run state: created lazily
      on first accepted batch, torn down unconditionally in
      `cleanupChildHandles` on every terminal path, swallowing its own
      close/unlink errors.
- [x] `handleStreamEvidenceMessage` now requires, post-`flushAll()`:
      `outcomes.emitted === acceptedKeysDb.distinctCount(stream)` (closes
      both intra-run duplicates and rejected-record claims in one equality,
      since a rejected or repeated key never adds a second distinct entry —
      no separate subtraction term is needed). [STALE as originally
      written, corrected here: this bullet originally said
      `outcomes.gapped <=` this run's own durable `DETAIL_GAP` count — a
      one-sided ceiling. Round 3 fixed this to an equality: `outcomes.gapped`
      must equal this run's own distinct durable `DETAIL_GAP` count for
      the stream (deduplicated by `gap_id`), after independent review
      found the ceiling let an under-claim (e.g. `gapped: 1` when 2
      distinct durable gaps exist) pass silently. See section 7 below for
      the full history.]
- [x] Wired the strict, index-validating, oracle-tested ingest-response
      parser (`runtime/ingest-failure.ts`'s `readIngestResponse`, previously
      unimported dead code guarded only by
      `test/read-ingest-response-oracle.test.ts`) in place of the weaker
      inline parser that dropped the `rejections` vector on the floor.
      `runtime/index.ts`'s local `readIngestResponse` now delegates to it;
      `IngestResult` is a type alias for the strict module's shape.
- [x] `buildCollectionFacts` (`connector-gap-bounding.ts`) derives
      `covered = outcomes.emitted + outcomes.unchanged` for the
      `RuntimeCollectionFact` fold, deliberately excluding `gapped`/
      `unaccounted` so either being nonzero routes the stream to
      `partial`/`retryable_gap` through the same unmodified
      `evaluateStreamCoherence` rule already gating every other stream
      shape — no new gating code was added to `coherence.ts` or
      `connector-coverage-policy.ts`.
- [x] Migrated `test/stream-evidence.test.ts` and
      `test/stream-evidence-flush-ordering.test.ts` off the scalar
      `covered` wire shape; added the required new coverage across those
      files plus the new `test/stream-evidence-accepted-keys.test.ts`:
      duplicates (intra-run repeated key), rejected records, all-unchanged,
      mixed outcomes, sum mismatch, drift-skip (no insert), gapped/
      unaccounted blocking `complete`, zero/zero, teardown, and
      mutation-sensitive controls for each new check. (Round 2 below adds
      compound-key duplicates, terminal-fact enforcement, and a genuine
      forced-503 retry — the round-1 "retry" coverage was found to be
      mislabeled and is corrected there.)
- [x] Ran focused tests, RI typecheck, `openspec validate --strict`, and the
      relevant inventory/CI-mode gates; no regression in the existing suite.
- [x] Owner-token scoping (the child holding `PDPP_OWNER_TOKEN` and able to
      bypass the runtime entirely) is explicitly out of scope for this
      section, per the terminal review §10.3 — tracked separately, not
      folded in here. Remains out of scope in round 2 below.

## 7. P1-2 round 2: independent-review repair packet (REVISE verdict)

Independent review (`STREAM-EVIDENCE-P1-2-INDEPENDENT-REVIEW.md`) found the
round-1 diff REVISE with 3 P1 blockers and 4 P2s. This section tracks the
six-item smallest repair packet, landed as a separate signed-off commit
(not amending the round-1 commit).

- [x] **P1-1 (compound keys not canonical).** `acceptedKeysDb.record()`
      (`runtime/index.ts`) used `String(record.key)`, which collapses
      distinct compound (array) keys that share a comma-joined
      representation (review's oracle: `["a","b,c"]` and `["a,b","c"]`
      both stringify to `"a,b,c"`). Replaced with `encodeKey` — the same
      canonical minified-JSON-array encoding `server/records.ts` uses for
      RS-side key storage — imported directly rather than duplicated.
      Added a collision test (two distinct compound keys, both counted)
      and a duplicate-control test (the same compound key sent twice,
      still collapses to one). Mutation-verified: reverting to
      `String(record.key)` flips exactly the collision test red.
- [x] **P1-2 (STREAM_EVIDENCE not terminal).** A RECORD or DETAIL_GAP for a
      stream after its accepted STREAM_EVIDENCE was still admissible,
      allowing `RECORD → STREAM_EVIDENCE{emitted:1} → RECORD → DONE` to
      succeed despite the equality being true only at evidence-time, false
      at run-end. Both `handleRecordMessage` and `handleDetailGapMessage`
      now reject a message for a stream already present in
      `streamEvidenceByStream`. Added two rejection tests (late RECORD,
      late DETAIL_GAP) and one scope-guard mutation control (a RECORD for
      a DIFFERENT stream after STREAM_EVIDENCE for another stream must
      still be accepted). Mutation-verified: reverting either guard flips
      exactly its own test red.
- [x] **P1-3 (autocommit at scale).** `acceptedKeysDb.record()`'s per-row
      `insertStmt.run()` calls ran as implicit autocommit (one transaction
      per row) — the review measured ~87x slower than batching (1,738ms/20
      rows vs 218ms/100k rows). Wrapped the per-flush insert loop in one
      `BEGIN IMMEDIATE` / `COMMIT` transaction, with `ROLLBACK` on any
      insert failure (a rollback failure itself is swallowed so it cannot
      mask the original error). Benchmarked 1,000,000 prepared inserts in
      one transaction on this session's hardware: **1,168ms**, confirmed
      by a fresh `distinctCount` read of exactly 1,000,000. Confirmed
      rollback leaves zero rows after a forced mid-transaction constraint
      violation.
- [x] **P2 (teardown not guaranteed on every exit).** The `childTerminalEvent
      .then(async (terminalEvent) => {...})` callback (`runtime/index.ts`)
      performed fallible work (`clearTerminateTimer()`, `stderrTail.finalize()`,
      redaction, diagnostic building) before its own inner `try`, with the
      outer `.catch((error) => reject(error))` providing no cleanup path.
      Wrapped the entire callback body in `try { ... } finally {
      cleanupChildHandles(); }` — safe because `cleanupChildHandles` is
      already idempotent (the `cleanedUp` guard makes every call after the
      first a no-op). Added a real owner-cancellation teardown test
      (previously untested: cancel mid-run after a durable accept, assert
      the temp store is gone). Proved the `finally` itself is load-bearing
      via a temporary, reverted source mutation (an unconditional throw
      injected immediately after `clearTerminateTimer()`, run against the
      cancellation test's fixture with the assertion loosened to tolerate
      the injected rejection): the run correctly rejected with the
      injected error, and the temp-store-empty assertion still passed —
      both the runtime mutation and the test-side probe were reverted
      immediately after recording this result; no permanent test hook was
      added to production source.
- [x] **P2 (retry/mutation proof not credible).** The round-1 "retry" test
      (renamed to `"...two keys split across separate BATCH_SIZE-forced
      flushes both count exactly once (batching, not retry)"`) injected no
      503/network failure and asserted no second POST, as the review
      found. Added a genuine test: a scripted stub RS forces one 503, the
      run retries, and the test asserts exactly 2 ingest POSTs with
      byte-identical bodies, plus a mutation control (a non-retryable 4xx
      gets exactly 1 POST, never retried). Mutation-verified: disabling
      `isRetryableIngestStatus` flips exactly the real retry test red.
- [x] **P2 (spec/OpenSpec bookkeeping, checklist claims).** Reconciled:
      (a) `run_id` duplicate-rejection scope — **[HISTORICAL, SUPERSEDED —
      see the round-4 note earlier in this section for current state.]**
      At the time this bullet was written (round 2/3), the fix was:
      relaxed `spec-collection-profile.md` rule 5 to state the guarantee
      without prescribing the mechanism, and corrected
      `specs/polyfill-runtime/spec.md`'s false claim that the RI compares
      `parent.runId === child.runId` (it does not; documented the
      then-actual, safe, narrower-but-sufficient Map-lifetime mechanism
      instead). ~~That Map-lifetime mechanism is no longer what ships~~:
      round 4 replaced it with a durable cross-invocation registry
      (`claimStreamEvidenceForRunId` / `stream_evidence_run_registry`,
      primary key `(run_id, stream)`), since a second independent review
      found "narrower" mischaracterized behavior that was in fact more
      permissive than the spec requires — see the round-4 note above for
      the accurate, current description. `specs/polyfill-runtime/spec.md`
      now documents the durable registry, not the Map-lifetime mechanism.
      (b) gap
      reconciliation — `durableGappedForStream` now dedupes by `gap_id`
      (a pending gap later recovered/terminalized/quarantined was pushed
      to `durableDetailGaps` more than once, over-counting one logical
      gap), with updated error-message wording ("distinct durable
      DETAIL_GAP count") and matching spec prose; (c) this file's own
      prior claim that `scripts/ci-mode.ts`'s ambient `ConnectorMessage`
      type was updated — false; the file has no such type at all, and the
      actual edit was to `spec-collection-profile.md`'s illustrative
      TypeScript code fence — corrected in section 6 above; (d) the
      round-1 implementation report's claims about a "duplicate-writer"
      incident and "two response-stub files needed migration" were
      independently found factually wrong — see the corrected report for
      the accurate account (the two-Claude-process overlap was a real
      concurrent-worktree-writer incident, not "repository-copy drift" as
      the report described it; five test files' stub ingest responses
      needed migration for the strict-parser envelope, not two).
- Explicitly unchanged from round 1: owner-token credential scoping
  remains out of scope (design review §10.3); no `vendor/`, package
  manifest, `pnpm-lock.yaml`, or `data-connect` files touched.
