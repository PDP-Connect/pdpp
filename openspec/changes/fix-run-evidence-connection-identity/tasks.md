## 1. Runtime Evidence

- [x] Stamp runtime-authored run events with `connection_id` and `connector_instance_id` when the controller supplies a connection id.
- [x] Preserve public source identity as `{ kind: "connector", id: <connector_id> }`.

## 2. Run Summary Projection

- [x] Project `connection_id` and `connector_instance_id` from run event data in SQLite summaries.
- [x] Project the same fields from Postgres summaries.

## 3. Regression Coverage

- [x] Add runtime/spine coverage proving event summaries expose the connection id.
- [x] Add owner-summary coverage proving a same-connector manual run attaches only to the addressed connection.

## 4. Validation

- [x] `openspec validate fix-run-evidence-connection-identity --strict`
- [x] Targeted reference tests for runtime spine and connection summary projection.
- [x] Postgres runtime-storage proof for run-summary connection identity.
- [x] `pnpm --dir reference-implementation typecheck`
- [ ] Deploy and verify live same-connector direct runs update the correct row.
