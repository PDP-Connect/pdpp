## 1. Contract

- [x] Specify the `STREAM_EVIDENCE` message, its validation rules, and its
      non-interaction with checkpoint-commit eligibility.
- [x] Specify runtime folding of `STREAM_EVIDENCE` into
      `RuntimeCollectionFact` without touching `coherence.ts`,
      `connector-coverage-policy.ts`, or the eligible-checkpoint algorithm.
- [ ] Validate the OpenSpec change strictly (`openspec validate
      prove-state-stream-child-coverage --strict`).

## 2. Root protocol spec

- [ ] Add `STREAM_EVIDENCE` to `spec-collection-profile.md` §3 (Connector to
      Runtime messages), including the field table, validation rules, and
      the TypeScript `ConnectorMessage` union member.
- [ ] Add `STREAM_EVIDENCE` to the connector-conformance and
      runtime-conformance checklists (§4).
- [ ] Cross-reference `STREAM_EVIDENCE` from the `DETAIL_COVERAGE` section's
      `state_stream` prohibition, so a reader hits the alternative
      immediately after reading why `DETAIL_COVERAGE` is closed off.

## 3. Runtime (not implemented in this lane)

- [ ] Add `trackStreamEvidence(msg)`, parallel to `trackDetailCoverage`, with
      the five rejection rules from the `polyfill-runtime` spec delta.
- [ ] Fold accepted `STREAM_EVIDENCE` facts into `RuntimeCollectionFact` at
      the point `buildCollectionFacts` assembles the terminal collection
      report.
- [ ] Add discriminating tests: clean coverage → `complete`; gapped keys →
      `retryable_gap`; unaccounted key (simulated swallowed exception,
      `covered < considered` with `pending_detail_gaps: 0`) → `partial`,
      never `complete`; no `STREAM_EVIDENCE` emitted → unchanged
      inheritance/`unknown`.
- [ ] Add rejection tests for each of the five validation rules
      (`reference_only` not `true`; out-of-scope `stream`; non-`state_stream`
      stream shape; `covered > considered` or negative counts; duplicate
      per stream/run).
- [ ] Add a negative test proving `DETAIL_COVERAGE` naming a `state_stream`
      child is still rejected after this change ships.
- [ ] Add a negative test proving no code path lets accepting, rejecting, or
      omitting `STREAM_EVIDENCE` change any checkpoint's commit eligibility
      (assert `missingDetailCoverageReports`/`recordDetailCoverageShortfalls`
      output is unaffected by `STREAM_EVIDENCE` presence).

## 4. Mutation checks (not run in this lane — recorded for the implementing change)

- [ ] Delete the enumeration-site `considered` push in a reference connector
      → the swallowed-exception test must go red.
- [ ] Move the `considered` push to after the throw-prone work → the
      swallowed-exception test must go red (this is the design's actual
      failure mode from the rejected `detail_gap_accounted` proposal; if it
      does not go red, the test mirrors the implementation rather than
      exercising it).
- [ ] Invert a connector's boundary-established predicate to always-true →
      the quiet-run test must go red.
- [ ] Delete the `state_stream`-shape check in `trackStreamEvidence` →
      the parent_streams-rejection test must go red.

## 5. Verification (deferred)

- [ ] Run focused lint, typecheck, connector, and runtime tests once
      implemented.
- [ ] Run the full connector and runtime regression suites.
- [ ] Obtain an independent checker verdict on the implementation diff.

Per instructions for this lane: no production code, no test files, and no
mutation checks are executed here. Section 1 and the spec deltas are the
deliverable; sections 3-5 are the checklist for the follow-on implementing
change.
