# Collection Profile Conformance Coverage

**Date:** 2026-04-12 (finalized)
**Suite:** `e2e/test/collection-profile.test.js`
**Status:** 9 pass, 0 fail, 0 skipped

---

## What is covered

| # | Spec requirement | Test | Status |
|---|-----------------|------|--------|
| 1 | RECORD messages emitted by connector are ingested to RS | `runtime ingests RECORD messages to the RS` | **Covered** |
| 2 | STATE only committed on DONE(succeeded) | `STATE is only committed when DONE status is succeeded` | **Covered** |
| 3 | single_use runs do not persist STATE | `single_use runs do not persist STATE even on success` | **Covered** |
| 4 | Runtime checks bindings before spawn, fails fast | `runtime rejects connectors with unsatisfied required bindings` | **Covered** |
| 5 | SKIP_RESULT is a valid message type | `runtime accepts SKIP_RESULT messages without error` | **Covered** |
| 6 | INTERACTION round-trip: connector requests input, gets response, continues | `INTERACTION round-trip allows connector to continue collecting` | **Covered** |
| 7 | DONE(failed) does not flush remaining buffered records | `DONE(failed) does not flush remaining buffered records` | **Covered** |
| 8 | STATE is scoped per-connector, not global | `STATE from one connector does not affect another` | **Covered** |

## What is partially covered

| Requirement | Coverage | Gap |
|------------|---------|-----|
| START message shape and delivery | Implicitly tested (all tests send START) but no test asserts the exact START shape or that the connector received it correctly | Could add a test where the connector echoes START fields to verify |
| Scope enforcement (connector cannot exceed grant) | Not directly tested. The runtime currently trusts the connector. | The spec says START carries scope but doesn't normatively require the runtime to reject out-of-scope RECORDs — this may be a spec gap |

## What is not covered

| Requirement | Why | Priority |
|------------|-----|----------|
| Connector crash / unexpected exit handling | The spec says DONE must be the final message. No test covers what happens when the connector crashes without DONE. The runtime handles this (proc.on('close') resolves with failed status) but it's not tested. | Medium |
| INTERACTION timeout | No test covers what happens if INTERACTION is never responded to. The spec doesn't specify a timeout. | Low (no spec requirement) |
| Incremental vs full_refresh collection mode | Tests use full_refresh. No test verifies that incremental mode passes the previous state correctly. | Medium (covered by the main e2e test suite in pdpp.test.js) |
| PROGRESS message handling | The spec mentions PROGRESS as an optional message. Not tested. | Low (informational only) |

## Resolved ambiguity

**Double INTERACTION processing.** The spec rule stands: a connector MUST NOT emit INTERACTION while already in `waiting_for_interaction`. A non-normative note was added to the Collection Profile acknowledging that sequential JSONL runtimes make this violation unrepresentable in practice, while the rule remains valid for connector behavior and concurrent runtime architectures.

The double-INTERACTION test was removed from the black-box conformance suite because the violation is not observable at the wire level with a sequential runtime. The runtime's internal defensive guard can be tested separately as a unit test if desired. Full analysis at `tmp/double-interaction-ambiguity-memo.md`.

## Harness caveats

- Tests use `closeAllConnections()` (Node 19+) for clean server shutdown. Earlier Node versions would hang.
- Test connectors are generated as temporary `.js` files with `import` syntax. Node emits a `MODULE_TYPELESS_PACKAGE_JSON` warning because there's no package.json in /tmp. This is cosmetic.
- Port allocation is sequential. Running tests concurrently with other PDPP tests may cause port collisions.

## Honest claim

The Collection Profile's core runtime invariants are tested and passing. The suite covers the eight most load-bearing protocol rules — the rules an independent implementation would most likely get wrong. One behavioral ambiguity was found, analyzed, and resolved (double INTERACTION — spec rule stands, test removed from black-box suite, non-normative note added).

"Validated" would require additional coverage: scope enforcement, connector crash recovery, and incremental mode state passthrough. The first two are untested; the third is covered by the broader `pdpp.test.js` suite. The current suite supports the claim that **the Collection Profile's core runtime invariants are conformance-tested**, not that the profile is fully validated.
