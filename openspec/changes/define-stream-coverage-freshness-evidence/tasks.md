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

## 4. Connector Backfill

- [x] 4.1 Backfill high-impact message and local-device connectors: ChatGPT, Slack, GitHub, WhatsApp, and Claude/Codex local exports.
- [x] 4.2 Backfill list/detail commerce and finance connectors: Amazon, Chase, USAA, YNAB, and Reddit.
- [x] 4.3 Backfill remaining connectors or mark streams with explicit unavailable/deferred/not-trackable strategies.
- [x] 4.4 Add a generated inventory report showing every declared stream has a coverage and freshness posture.
- [x] 4.5 Emit WhatsApp attachment `DETAIL_COVERAGE` from parsed media inventory so parent-detail stream rows do not remain unmeasured.

## 5. Acceptance Checks

- [x] 5.1 `openspec validate define-stream-coverage-freshness-evidence --strict`
- [x] 5.2 Shared contract/schema tests pass.
- [x] 5.3 Runtime collection-report tests pass.
- [x] 5.4 Reference connection-health and owner-surface tests pass.
- [x] 5.5 Live owner-instance audit shows no resting stream row whose next step is generic "checking" solely because evidence is missing.
