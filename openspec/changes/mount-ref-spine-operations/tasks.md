## 1. Baseline

- [x] 1.1 Inventory `/_ref/{traces,grants,runs,search}` and per-id timeline route flows.
- [x] 1.2 Confirm existing response shapes pinned by `event-spine`, `disclosure-spine-conformance-*`, and `security-auth-surfaces` tests.
- [x] 1.3 Identify spine read dependencies to inject into the operation modules.

## 2. Operation Modules

- [x] 2.1 Implement `ref.spine.correlations.list` operation (drives `/_ref/traces`, `/_ref/grants`, `/_ref/runs`).
- [x] 2.2 Implement `ref.spine.events.page` operation (drives the three per-id timelines, including live-bearer redaction).
- [x] 2.3 Implement `ref.spine.search` operation (drives `/_ref/search`).
- [x] 2.4 Keep all three operation modules free of Fastify, Next, SQLite, process/env, raw DB, and `server/*` host imports.

## 3. Host Mounts

- [x] 3.1 Update `/_ref/traces`, `/_ref/grants`, `/_ref/runs` Fastify routes to delegate envelope assembly to `ref.spine.correlations.list`.
- [x] 3.2 Update `/_ref/traces/:traceId`, `/_ref/grants/:grantId/timeline`, `/_ref/runs/:runId/timeline` to delegate to `ref.spine.events.page`.
- [x] 3.3 Update `/_ref/search` to delegate to `ref.spine.search`.
- [x] 3.4 Preserve owner-auth gates, contract metadata, and `InvalidCursorError` → 400 mapping at the host layer.

## 4. Tests

- [x] 4.1 Add operation-boundary tests for the three new modules.
- [x] 4.2 Add operation-behavior tests for envelope discriminators, pagination optionality, and per-event redaction.
- [x] 4.3 Run existing `event-spine`, `disclosure-spine-conformance-*`, and `security-auth-surfaces` suites against the mounted operations.

## 5. Validation

- [x] 5.1 Run targeted `node --test` for the new operation tests + spine route tests.
- [x] 5.2 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.3 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.4 Run `openspec validate mount-ref-spine-operations --strict`.
- [x] 5.5 Run `openspec validate --all --strict`.
- [x] 5.6 Run `pnpm workstreams:status -- --no-fail`.
