# Collection Profile Conformance Coverage

**Date:** 2026-04-17 (updated)
**Suite:** `reference-implementation/test/collection-profile.test.js`
**Status:** 41 pass, 0 fail, 0 skipped

---

## What is covered

| # | Spec requirement | Test | Status |
|---|-----------------|------|--------|
| 1 | START message carries normalized runtime contract fields and no legacy config | `runtime sends spec-shaped START with non-empty scope and no legacy config` | **Covered** |
| 2 | Incremental runs pass prior state through START | `incremental runs pass prior state through START` | **Covered** |
| 3 | Connectors can branch on `START.collection_mode` | `connectors can branch on START.collection_mode` | **Covered** |
| 4 | RECORD messages emitted by connector are ingested to RS | `runtime ingests RECORD messages to the RS` | **Covered** |
| 5 | STATE only committed on DONE(succeeded) | `STATE is only committed when DONE status is succeeded` | **Covered** |
| 6 | single_use runs do not persist STATE | `single_use runs do not persist STATE even on success` | **Covered** |
| 7 | grant-scoped STATE stays isolated from global state and other grants | `grant-scoped STATE stays isolated from global state and other grants` | **Covered** |
| 8 | single_use grant runs do not persist grant-scoped STATE | `single_use with grant-scoped STATE still persists nothing` | **Covered** |
| 9 | Runtime rejects out-of-scope RECORDs for undeclared streams, resources, fields, and time ranges | `runtime rejects RECORD messages outside declared START.scope*` | **Covered** |
| 10 | Runtime checks bindings before spawn, fails fast | `runtime rejects connectors with unsatisfied required bindings` | **Covered** |
| 11 | SKIP_RESULT is a valid message type | `runtime accepts SKIP_RESULT messages without error` | **Covered** |
| 12 | PROGRESS is accepted as an informational runtime message | `runtime accepts PROGRESS messages without error` | **Covered** |
| 13 | INTERACTION round-trip: connector requests input, gets response, continues | `INTERACTION round-trip allows connector to continue collecting` | **Covered** |
| 14 | Runtime can time out INTERACTION and return a timeout response to the connector | `runtime returns INTERACTION timeout responses when the handler does not answer in time` | **Covered** |
| 15 | Runtime can convert aborted INTERACTION handling into a cancelled response and allow the connector to continue | `runtime returns INTERACTION cancelled responses when the handler aborts` | **Covered** |
| 16 | DONE(failed) does not flush remaining buffered records | `DONE(failed) does not flush remaining buffered records` | **Covered** |
| 17 | Unexpected connector exit before STATE fails the run, preserves no state, and leaves buffered records unflushed | `unexpected connector exit before STATE fails the run, preserves no state, and leaves buffered records unflushed` | **Covered** |
| 18 | Unexpected connector exit after STATE fails the run, preserves no state, and records `run.failed` even when STATE already flushed records | `unexpected connector exit after STATE fails the run, preserves no state, and records run.failed` | **Covered** |
| 19 | Graceful connector exit without DONE still fails the run and records `run.failed` | `graceful connector exit without DONE still fails the run and records run.failed` | **Covered** |
| 20 | Unexpected connector exit after crossing a batch-flush boundary preserves flushed records but drops the remaining buffered tail | `unexpected connector exit after a batch flush preserves flushed records but drops the remaining buffered tail` | **Covered** |
| 21 | STATE is scoped per-connector, not global | `STATE from one connector does not affect another` | **Covered** |
| 22 | `STATE` currently flushes and stages only the named stream when other streams still have buffered records | `STATE currently flushes and stages only the named stream when other streams still have buffered records` | **Covered** |
| 23 | Multiple staged stream checkpoints commit successfully without requiring a cross-stream ordering guarantee | `multiple staged stream checkpoints commit successfully without requiring a cross-stream ordering guarantee` | **Covered** |
| 24 | Multiple staged stream checkpoints still commit nothing when the run fails after staging | `multiple staged stream checkpoints still commit nothing when the run fails after staging` | **Covered** |
| 25 | `DONE(failed)` after staging multiple stream checkpoints still commits none of them | `DONE(failed) after staging multiple stream checkpoints still commits none of them` | **Covered** |
| 26 | Runtime rejects `DONE` / exit mismatches as protocol violations | `DONE(* ) with an exit-code mismatch is treated as a protocol violation*` | **Covered** |
| 27 | Runtime rejects mismatched `DONE.records_emitted` counters as protocol violations | `DONE(* ) with mismatched records_emitted is treated as a protocol violation*` | **Covered** |

## What is partially covered

| Requirement | Coverage | Gap |
|------------|---------|-----|
| START message shape and delivery | Explicitly tested via captured START payload, including incremental-state passthrough | Additional edge cases can stay in targeted runtime tests |
| Scope enforcement (connector cannot exceed grant) | Covered for undeclared streams, `resources`, `fields`, and `time_range` at the runtime boundary | The remaining question is how much of this should become explicit conformance language versus a strong reference choice |

## What remains open or low-priority

| Requirement | Why | Priority |
|------------|-----|----------|
| Additional batching edge cases beyond the current partial-flush characterization | The suite now covers pre-STATE exit, post-STATE exit, graceful exit without DONE, crash after crossing one ingest batch boundary, the current per-stream `STATE` boundary when other streams still have buffered records, successful multi-stream checkpoint commit without relying on a cross-stream ordering guarantee, the matching failed-run case where multiple streams stage checkpoints but none commit, and the explicit `DONE(failed)` variant of that same multi-stream staged-checkpoint case. More exotic buffering permutations can stay in targeted runtime characterization tests unless they become an interoperability concern. | Low |
| INTERACTION terminal-status normativity | The reference now proves runtime `timeout` and `cancelled` behavior, but the spec still does not say whether those terminal statuses are Collection Profile requirements or runtime/reference-only choices. | Low (open spec question, now documented in OpenSpec) |
| DONE terminal-counter verification | The reference now proves runtime rejection of mismatched `DONE.records_emitted`, but the spec still does not say whether runtimes must verify connector-reported terminal counters or may treat them as informational only. | Low (open spec question, now documented in OpenSpec) |
| PROGRESS message handling | Acceptance of PROGRESS as a non-terminal informational message is covered. Remaining gap would be richer assertions about how operators consume progress, which is reference/runtime behavior rather than core conformance. | Low |

## Resolved ambiguity

**Double INTERACTION processing.** The spec rule stands: a connector MUST NOT emit INTERACTION while already in `waiting_for_interaction`. The reference runtime now enforces this at connector-output arrival time, so the violation is black-box observable and covered by the conformance suite rather than remaining only an internal guard or design memo.

## Harness caveats

- Tests use `closeAllConnections()` (Node 19+) for clean server shutdown. Earlier Node versions would hang.
- Test connectors are generated as temporary `.js` files with `import` syntax. Node emits a `MODULE_TYPELESS_PACKAGE_JSON` warning because there's no package.json in /tmp. This is cosmetic.
- Port allocation is sequential. Running tests concurrently with other PDPP tests may cause port collisions.

## Honest claim

The Collection Profile's core runtime invariants are tested and passing. The suite now covers the main wire-level rules an independent implementation would most likely get wrong, including START shape, incremental-state passthrough, grant-scoped state behavior, START.scope enforcement, blocked interaction semantics including overlapping `INTERACTION` rejection, interaction round-trip plus runtime `timeout` / `cancelled` terminal responses, the current per-stream `STATE` boundary, successful multi-stream checkpoint commit without assuming a cross-stream ordering guarantee, the matching failed-run multi-stream checkpoint case, terminal `DONE` / exit-code consistency, runtime rejection of mismatched terminal `records_emitted` counters, the explicit `DONE(failed)` multi-stream staged-checkpoint case, and the difference between exiting before STATE, after STATE, and without DONE at all.

"Validated" would still require broader treatment of operator-facing runtime behavior, but the highest-signal wire-level gaps are now closed. The current suite supports the claim that **the Collection Profile's core runtime invariants, including START shape, `collection_mode` delivery, START.scope enforcement, incremental-state passthrough, blocked interaction semantics including overlapping `INTERACTION` rejection, interaction round-trip plus runtime `timeout` / `cancelled` terminal responses, the current per-stream `STATE` boundary, successful and failed multi-stream checkpoint behavior without a cross-stream ordering guarantee, terminal `DONE` / exit-code consistency, terminal `records_emitted` counter validation, including the explicit `DONE(failed)` staged-checkpoint case, and unexpected-exit handling before STATE, after STATE, across a batch flush boundary, and on graceful exit without DONE, are conformance-tested**, not that the profile is fully validated.
