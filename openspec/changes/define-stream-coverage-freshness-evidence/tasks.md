## 1. Contract And Types

- [x] 1.1 Add stream coverage evidence and stream freshness evidence types to the reference runtime/control-plane contract.
- [x] 1.2 Extend manifest stream validation to require a coverage strategy and freshness strategy for new or touched streams.
- [x] 1.3 Preserve compatibility for existing `coverage_policy` values during migration and test each mapping.
- [x] 1.4 Add a developer audit that lists streams with missing evidence strategy and fails only for new debt.

## 2. Runtime Report Normalization

- [x] 2.1 Extend collection-report normalization to carry per-stream coverage and freshness evidence.
- [x] 2.2 Map existing `DETAIL_COVERAGE` messages into `parent_detail_accounting` evidence.
- [x] 2.3 Map flat/snapshot/singleton streams into the correct evidence strategies without reading record payloads.
- [x] 2.4 Add tests for historical reports with missing evidence projecting as unmeasured, not runtime failure.

## 3. Reference Health Projection And UI

- [x] 3.1 Update connection-health projection to classify resting missing stream evidence as unmeasured.
- [x] 3.2 Ensure "checking" requires active bounded work evidence: active run, active probe, or active projection rebuild.
- [x] 3.3 Update source detail stream rows to render concrete coverage/freshness status from the shared collection report.
- [x] 3.4 Add dashboard, Sources, Syncs, and source-detail tests proving unknown-by-default is gone for instrumented streams.
- [x] 3.5 Thread local-device `coverage_diagnostics` into per-stream collection reports so local collector stream rows do not remain unmeasured after connection-level coverage is proven complete.
- [x] 3.6 Apply `state_stream` inheritance to local-device stream rows so co-emitted child streams do not remain unmeasured when the parent store scan is covered.
- [x] 3.7 Treat committed checkpoint-window, full-inventory, snapshot, and singleton strategies as coverage-complete even when the run emitted only changed records.
- [x] 3.8 Treat successful manual-only no-staleness runs as measured current-as-of instead of leaving source freshness unmeasured.
- [x] 3.9 Apply `state_stream` checkpoint inheritance to historical scheduler-run facts when the child fact exists, the parent checkpoint committed, and no child skip/gap is present.

## 4. Connector Backfill

- [x] 4.1 Backfill high-impact message and local-device connectors: ChatGPT, Slack, GitHub, WhatsApp, and Claude/Codex local exports.
- [x] 4.2 Backfill list/detail commerce and finance connectors: Amazon, Chase, USAA, YNAB, and Reddit.
- [x] 4.3 Backfill remaining connectors or mark streams with explicit unavailable/deferred/not-trackable strategies.
- [x] 4.4 Add a generated inventory report showing every declared stream has a coverage and freshness posture.
- [x] 4.5 Emit WhatsApp attachment `DETAIL_COVERAGE` from parsed media inventory so parent-detail stream rows do not remain unmeasured.
- [x] 4.6 Mark Slack `unsupported_in_mode` streams as non-required accepted-absent streams so historical no-skip facts do not project as resting unknown coverage.
- [x] 4.7 Make parent-detail producers that already know their run-time denominator and numerator emit explicit `considered` and `covered` counts so steady-state zero-emission runs still project complete. (Re-opened 2026-07-10: post-boot live runs on served revision `aec6cabe1` still rest unmeasured — USAA `transactions` never emits `DETAIL_COVERAGE` at all, USAA `statements` rested unmeasured on the 11:55Z post-deploy run despite #285, and several producers gate coverage emission on nonzero candidates. Closed on this branch: USAA `transactions` producer added, zero-candidate suppression removed from USAA/Chase statements and Amazon order_items, and section 8.4's shipped-manifest reproductions pin every audit-named row; live confirmation runs through the 9.1 machine audit after deploy + reruns.)

## 5. Acceptance Checks

- [x] 5.1 `openspec validate define-stream-coverage-freshness-evidence --strict`
- [x] 5.2 Shared contract/schema tests pass.
- [x] 5.3 Runtime collection-report tests pass.
- [x] 5.4 Reference connection-health and owner-surface tests pass.
- [x] 5.5 A required stream resting at unknown/unmeasured can never hide beneath a Healthy connection verdict. (Re-opened 2026-07-10: the live audit found 52 resting unmeasured stream rows across 10 active instances whose connection projection could still read Healthy; the prior check-off verified copy, not the rollup. Now enforced by the 6.2 rollup refusal (rollupCollectionReportCoverageOverride) and proven by collection-report-projection/connection-health-acceptance regressions; the 9.1 machine audit fails any live instance where it regresses. Live confirmation post-deploy is the owner's 9.1 live run.)

## 6. Connection Rollup Blocking

- [x] 6.1 Carry the manifest `required` flag on per-stream collection-report entries.
- [x] 6.2 Roll required-stream `unknown` coverage into the connection axis: block the clean-success `complete` promotion, resolve the axis to `unknown`, and never upgrade an already-degrading axis (worst-wins preserved).
- [x] 6.3 Stop the verdict stream-rollup from demoting a required unmeasured stream to `optional` priority under a `complete` connection axis.
- [x] 6.4 Emit a maintainer-audience, non-terminal required action for required-unmeasured streams so the owner state resolves to a maintainer disposition (advisory channel, no owner CTA, "Checking" only during active bounded work).
- [x] 6.5 Tests: rollup, verdict synthesis, owner-state resolution, and accepted-policy/local-diagnostic non-degradation regressions.

## 7. Canonical-Count Exactness

- [x] 7.1 Join declared manifest streams against a stable canonical live-record snapshot and synthesize exact-zero rows only when record-snapshot evidence is current at its exact source checkpoint; retained-size rows own byte/history/blob measures only. (Implemented by `reconcile-active-summary-evidence`; retained size is never count authority.)
- [x] 7.2 Console stream rows render "0 records" only from a current canonical snapshot and render count-unavailable/stale when record evidence is unobserved/stale/failed; retained-byte failure never erases a current count.
- [x] 7.3 Tests: mixed zero/nonzero streams under current record evidence, unobserved/stale/failed record evidence reads unavailable, dirty retained bytes preserve canonical counts, and a fresh local collector with zero live rows in declared streams projects exact zero on SQLite and real Postgres.

## 8. Scope-Exhaustive Runtime Facts And Producer Closure

- [x] 8.1 Maintain durable per-connection, per-stream latest-attempt evidence in the connector-summary read model (raw fact + evidence_as_of + run id; terminal-event-sequence fold checkpoint; deterministic rebuild/backfill outside the hot read path; connection-scoped, ambiguous legacy events refused; no run-count correctness limit). Dashboard reads consume the one bounded projection and derive coverage/freshness on read; the Healthy gate anchors freshness to the oldest required-stream proof. Run selection is never classified as `deferred`. Acceptance tests: a scoped run preserves prior proof for omitted streams; a never-measured omitted required stream still prevents Healthy; an explicit manifest-deferred stream remains accepted; an attempted-but-unresolved newest fact replaces older proof; stale omitted proof cannot ride a fresh scoped run to Healthy; evidence never crosses connections.
- [x] 8.2 Emit USAA `transactions` `DETAIL_COVERAGE` with explicit `considered`/`covered` from the per-account outcome accumulator (closes the surviving 4.7 gap).
- [x] 8.3 Remove zero-candidate suppression from parent-detail coverage producers: a steady-state run that enumerated its denominator SHALL emit `considered`/`covered` even when both are zero (USAA `statements`, Chase `statements`, Amazon `order_items`).
- [x] 8.4 Deterministic repro tests for the audit-named post-boot cases using the real shipped manifests: parse `packages/polyfill-connectors/manifests/<connector>.json`, feed the steady-state fact block the connector emits, and assert the projected coverage condition (Chase `balances`/`current_activity`, USAA `transactions`/`statements`, ChatGPT `custom_gpts`/`custom_instructions`/`memories`/`shared_conversations`, Slack accepted-absent quartet plus `channel_stats`, Reddit listing streams, Gmail `messages`/`threads`/`labels`/`message_bodies`).
- [x] 8.5 Make manifest-reconcile silence loud: log when reconciliation is disabled, skipped by environment, or scans zero manifests, so a live instance serving pre-backfill stored manifests is diagnosable from boot logs.

## 9. Machine Gates

- [x] 9.1 Reproducible machine audit that fails when a required stream rests unmeasured/unknown beneath a settled connection verdict: a seeded local test plus a live mode reusing the owner-journey acceptance harness. The audit distinguishes stored-manifest drift from producer gaps, treats active bounded work as inconclusive, excludes draft/setup connections, deduplicates evidence classes, and treats declared-stream count absence as inconclusive unless canonical `record_snapshot` evidence is current. `reference-implementation/test/stream-health-audit.test.js` proves current canonical exact-zero acceptance and stale canonical-snapshot refusal; retained-size is not count authority.
- [x] 9.2 Generated stream-evidence inventory artifact (per connector, per stream: strategies, policy, requiredness, `state_stream`) with a drift check wired into CI so new debt fails.
- [x] 9.3 Close the CI path hole: edits under `reference-implementation/manifests/**` must run the stream-evidence manifest guardrail test.
- [x] 9.4 Full-suite acceptance: strict OpenSpec validation, reference-implementation/polyfill-connectors/console suites, all workspace typechecks, diff check, and exact official touched-file lint delta. (Closure rerun passed: reference full suite, polyfill 2,630 pass/0 fail/6 skip, console view-model/stream suites, all typechecks, strict OpenSpec, diff checks; official 7d235132 base 61/candidate 52, delta -9.)

## 10. V2 Local-Device Health Authority

- [x] 10.1 Select health and collection-report evidence authority from persisted `source_kind` before run precedence. `local_device` SHALL not hydrate scheduler/latest-attempt facts; non-local behavior stays unchanged.
- [x] 10.2 Make the connection-scoped `coverage_diagnostics` STATE proof fail closed: require the exact committed `{ fetched_at, stores }` snapshot, durable manifest-generation equality, exact known-store/store-to-stream inventory, sanitized metadata, and worst-wins folding including malformed, legacy, dropped, extra, duplicate, conflicting, and `unaccounted` rows. SQLite and dedicated real Postgres produce the same safe projection; timestamps are presentation data, not eligibility machinery.
- [x] 10.3 Enforce local terminal-DONE, failure-gap, and recovery invariants: every terminal/protocol/child failure remains a blocking gap/backlog until a later successful full coverage STATE commits; a scoped non-coverage success or corrective heartbeat cannot recover it.
- [x] 10.4 Emit the full snapshot-bearing `coverage_diagnostics` STATE proof from both Claude Code and Codex only after full collection and before successful terminal completion.
- [x] 10.5 Reject run-now and every schedule mutation for a persisted `local_device` connection with a typed response, and render console modality from `source_kind`, not heartbeat presence.
- [x] 10.6 Add focused proof and mutation-killing tests: real producer protocol; runner failure/checkpoint ordering; legacy/partial/malformed duplicate snapshot failures; no-op proof-generation advancement; production summary/audit; privacy sentinel; connection isolation; and SQLite/dedicated-real-Postgres parity.
- [x] 10.7 Close independent adversarial findings: exact shared inventory accounting, future-proof rejection, active-run quarantine, definitive-blocked heartbeat preservation, unrecovered-gap backlog, and terminal protocol state-machine controls. (Re-closed 2026-07-21 final re-gate: unsupported-authority and all pinned public error-code contract controls are raw green.)
