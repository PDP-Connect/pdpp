## 1. Contract (this change — spec/design, no destructive runtime)

- [x] 1.1 Verify the data-model reference topology for a connection at this commit: `records`/`record_changes`/`version_counter`/`blobs`/search indices keyed `connector_instance_id NOT NULL`; `connector_schedules`/`controller_active_runs` PK `connector_instance_id`; `device_source_instances.connector_instance_id` nullable soft-ref; `spine_events` has no `connector_instance_id`; grant-scoped read filters on `connector_instance_id`. (Evidence cited in `design.md` cascade table.)
- [x] 1.2 Decide `delete_connection` semantics and keep it distinct from `revoke_connection`, grant-package revoke, retention policy, and provider/device credential revocation. (`design.md` "The four adjacent semantics" + "What delete_connection means": full connection-scoped purge of data + config row, clear device back-ref, preserve audit/siblings/devices/grants.)
- [x] 1.3 Specify the cascade (erase / clear / preserve / untouched) with file:line evidence. (`design.md` cascade table.)
- [x] 1.4 Specify safety invariants I1–I10 (blast radius, explicit erasure, audit preserved, typed idempotency, foreign/unknown, default-account no-resurrection, no-delete-under-active-run, transactional, `/mcp` unaffected, grants untouched). (`design.md` "Safety invariants".)
- [x] 1.5 Specify typed errors and the store + route contracts the future lane implements. (`design.md` "Typed errors", "Store primitive contract", "Route contract".)
- [x] 1.6 Add the `reference-connector-instances` and `reference-owner-agent-control-surface` spec deltas for connection-delete cascade and the owner-agent delete action. (`specs/**/spec.md` in this change.)
- [x] 1.7 No-runtime wording fix: update the `delete_connection` control-catalog `reason` in `reference-implementation/server/metadata.ts` to point at this specified cascade contract. Status stays `unsupported`; `method`/`urlTemplate` stay `null`; no route added.
- [x] 1.8 Strict OpenSpec validation for this change and `--all --strict`; `git diff --check`. (See Acceptance checks.)

## 2. Implementation (DEFERRED — separate future lane; gated on this contract)

- [ ] 2.1 Add by-instance, all-streams record-delete queries under `server/queries/records/delete/` (`WHERE connector_instance_id = ?`), parallel to the existing by-stream set; do NOT widen to `connector_id`.
- [ ] 2.2 Implement `deleteConnection(connectorInstanceId, { ownerSubjectId, now })` on the SQLite and Postgres connector-instance stores: transactional cascade (I8) keyed on one id (I1), clear `device_source_instances` back-ref, refuse on active-run lease (I7), return a non-secret deletion summary.
- [ ] 2.3 Implement the Decision-1 default-account no-resurrection guard (tombstone the deterministic id so `ensureDefaultAccountConnection` does not re-materialize a deleted default-account connection), OR type default-account delete `unsupported` with the tombstone-gap reason (I6).
- [ ] 2.4 Add `DELETE /v1/owner/connections/{connection_id}` + connector-only `DELETE /v1/owner/connectors/{connector_id}`, `requireToken` + `requireOwner`, ownership resolved before mutation, auto-select-or-409-ambiguous, idempotent per I4, active-run refusal per I7.
- [ ] 2.5 Emit non-secret `owner_agent.connection.delete` spine evidence on success and every failure (actor kind, client, target, selector, operation, outcome, deletion-summary counts, request id; no bearer, no record contents).
- [ ] 2.6 Add `@pdpp/reference-contract` ops `ownerDeleteConnection`/`ownerDeleteConnector` + the deletion-summary response schema.
- [ ] 2.7 Implement the full acceptance-test matrix from `design.md` (cascade completeness, no-sibling-overreach, records-unreadable-after, audit-preserved, idempotency, foreign/unknown, default-account no-resurrection, active-run refusal, transactional rollback, grants-untouched, auth, revoked-credential, connector-only ambiguity/auto-select).
- [ ] 2.8 Flip the `delete_connection` catalog descriptor (`server/metadata.ts`) `unsupported → supported` (`DELETE`, `/v1/owner/connections/{connection_id}`) in the SAME reviewable unit as 2.4 + 2.7. Update parent change `add-owner-agent-control-surface` tasks 3.1d / 6.1d to closed.

## Acceptance checks

This change is spec/design only. Reproducible checks:

```sh
pnpm exec openspec validate add-owner-connection-delete-contract --strict
pnpm exec openspec validate --all --strict
git diff --check
# No-runtime wording fix only — verify metadata still typed-unsupported, no route:
pnpm --dir reference-implementation run verify   # tsc --noEmit + ultracite, if node_modules present
```

The implementation lane (section 2) is NOT part of this change's acceptance. It runs against the contract here, with the `design.md` test matrix as its gate. No destructive route, store delete method, or catalog `supported` flip ships until that lane lands with proof.
