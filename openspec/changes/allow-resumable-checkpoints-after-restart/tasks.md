## 1. Owner decision (blocking)

- [ ] Owner rules on the narrow exception in `proposal.md`. Nothing below starts
      until the spec change is accepted — the current rule is normative and was
      deliberately written to cover this case (`spec-collection-profile.md`
      lines 151 and 497).

## 2. Spec

- [ ] Amend `spec-collection-profile.md` to admit the restart exception, stating
      the three eligibility conditions and keeping the fail-closed default for
      every other terminal shape.
- [ ] Name the restart disposition explicitly in the spec's terminal vocabulary,
      distinct from `failed` (outcome never observed vs. observed bad).

## 3. Implementation

- [ ] Add the manifest-derived eligibility predicate (a checkpoint stream named
      as a detail parent by any in-scope stream is ineligible), reusing the same
      reading of `parent_streams`/`state_stream` that
      `missingDetailCoverageReports` already applies.
- [ ] Commit an eligible checkpoint from `handleStateMessage`, after the
      existing `flushBatch(stateStream)` await.
- [ ] Report the checkpoint as already-durable in `run.state_staged`, so the
      timeline distinguishes a checkpoint that survives a restart from one that
      only survives to DONE.
- [ ] Leave the DONE-time commit path unchanged for every ineligible stream.

## 4. Tests

- [ ] Prove a connector that emits STATE and then exits WITHOUT DONE leaves its
      cursor durable — read back over `GET /v1/state/:connectorId`, the same
      surface the next run reads. Simulate the restart by killing the child
      after a flushed write; do not use a sleep or any timing proxy.
- [ ] Prove a detail-parent checkpoint does NOT commit early, so an unproven
      coverage verdict can never be skipped.
- [ ] Prove the existing contracts still hold: `DONE(failed)`,
      `DONE(cancelled)`, and every protocol-violation case in
      `test/collection-profile.test.ts` still commit nothing.
- [ ] Mutation-prove each new test in both directions (remove the eager commit;
      remove the safety predicate). A predicate mutation MUST fail the
      detail-parent test — an earlier attempt at this work had a safety test
      that passed with the guard removed, because its fixture manifest was
      being rejected and the assertion never exercised the path.

## 5. Validation

- [ ] D15 canary: kill a real run mid-walk, then verify the next run re-fetches
      nothing before the last committed boundary and that no detail-parent
      cursor advanced.
- [ ] Confirm idempotency still bounds the failure direction: re-walking an
      already-committed range re-upserts via
      `records_connector_instance_stream_key` rather than duplicating.
