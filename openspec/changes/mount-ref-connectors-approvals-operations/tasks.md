## 1. Baseline

- [ ] 1.1 Inventory current `/_ref/connectors`, `/_ref/connectors/:connectorId`, and `/_ref/approvals` route flows.
- [ ] 1.2 Confirm current response shapes and existing tests that pin them.
- [ ] 1.3 Identify data dependencies to inject into operation modules.

## 2. Operation Modules

- [ ] 2.1 Implement `ref.connectors.list` operation.
- [ ] 2.2 Implement `ref.connectors.detail` operation.
- [ ] 2.3 Implement `ref.approvals.list` operation.
- [ ] 2.4 Keep operation modules free of Fastify, Next, SQLite, process/env, and auth internals.

## 3. Host Mounts

- [ ] 3.1 Update `/_ref/connectors` route to call `ref.connectors.list`.
- [ ] 3.2 Update `/_ref/connectors/:connectorId` route to call `ref.connectors.detail`.
- [ ] 3.3 Update `/_ref/approvals` route to call `ref.approvals.list`.
- [ ] 3.4 Preserve owner-auth gates and existing error envelopes.

## 4. Tests

- [ ] 4.1 Add operation-boundary tests for the three modules.
- [ ] 4.2 Add or update behavior tests for connector list/detail parity.
- [ ] 4.3 Add or update behavior tests for approval list parity.
- [ ] 4.4 Run consent/device conformance tests to prove approval prerequisites remain valid.

## 5. Validation

- [ ] 5.1 Run connector/control-plane tests.
- [ ] 5.2 Run approval/security owner-gate tests.
- [ ] 5.3 Run operation-boundary tests.
- [ ] 5.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 5.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 5.6 Run `openspec validate mount-ref-connectors-approvals-operations --strict`.
- [ ] 5.7 Run `openspec validate --all --strict`.
