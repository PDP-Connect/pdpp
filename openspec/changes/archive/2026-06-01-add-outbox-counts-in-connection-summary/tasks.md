## 1. Reference projection

- [x] 1.1 Add `rollupOutboxDiagnosticCounts` to `connection-health.ts` with unit tests (sum across rows, earliest `oldest_pending_at`, null when no counts).
- [x] 1.2 Add `outboxDiagnostics` to `HeartbeatRow` and roll trusted rows' diagnostics into a new `outbox_counts` field on `LocalDeviceProgress` in `projectLocalDeviceProgress`, with unit tests (trusted-only, null path, multi-row sum).

## 2. Console surface

- [x] 2.1 Add `outbox_counts` to `RefLocalDeviceProgress`.
- [x] 2.2 Surface a count-backed scale line in `summarizeOutboxStallRemediation` / the stalled-remediation panel, with helper/structural tests proving counts render only on stalled and never on healthy/idle/active/unknown.

## 3. Validation

- [x] 3.1 Run targeted reference tests (`ref-connectors-list-operation`, `connection-health`).
- [x] 3.2 Run `pnpm --dir reference-implementation run verify`.
- [x] 3.3 Run targeted `apps/console` connection-evidence / diagnostics tests.
- [x] 3.4 Run `pnpm --dir apps/console run types:check` and `run check`.
- [x] 3.5 Run `openspec validate add-outbox-counts-in-connection-summary --strict`.
- [x] 3.6 Run `openspec validate --all --strict`.
- [x] 3.7 Run `git diff --check`.
