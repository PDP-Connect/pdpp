## 1. Baseline

- [x] 1.1 Inventory current `/_ref/connectors`, `/_ref/connectors/:connectorId`, and `/_ref/approvals` route flows.
- [x] 1.2 Confirm current response shapes and existing tests that pin them.
- [x] 1.3 Identify data dependencies to inject into operation modules.

## 2. Operation Modules

- [x] 2.1 Implement `ref.connectors.list` operation.
- [x] 2.2 Implement `ref.connectors.detail` operation.
- [x] 2.3 Implement `ref.approvals.list` operation.
- [x] 2.4 Keep operation modules free of Fastify, Next, SQLite, process/env, and auth internals.

## 3. Host Mounts

- [x] 3.1 Update `/_ref/connectors` route to call `ref.connectors.list`.
- [x] 3.2 Update `/_ref/connectors/:connectorId` route to call `ref.connectors.detail`.
- [x] 3.3 Update `/_ref/approvals` route to call `ref.approvals.list`.
- [x] 3.4 Preserve owner-auth gates and existing error envelopes.

## 4. Tests

- [x] 4.1 Add operation-boundary tests for the three modules.
- [x] 4.2 Add or update behavior tests for connector list/detail parity.
- [x] 4.3 Add or update behavior tests for approval list parity.
- [x] 4.4 Run consent/device conformance tests to prove approval prerequisites remain valid.

## 5. Validation

- [x] 5.1 Run connector/control-plane tests.
- [x] 5.2 Run approval/security owner-gate tests.
- [x] 5.3 Run operation-boundary tests.
- [x] 5.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.6 Run `openspec validate mount-ref-connectors-approvals-operations --strict`.
- [x] 5.7 Run `openspec validate --all --strict`.
