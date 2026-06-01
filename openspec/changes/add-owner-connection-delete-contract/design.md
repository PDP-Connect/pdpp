## Context

`delete_connection` is the one destructive owner-agent control family with no existing primitive to reuse. `revoke_connection` shipped by sharing the connection-scoped `updateStatus → 'revoked'` soft-flip; `inspect_diagnostics` shipped by sharing the `listConnectorSummaries` projection. Delete has neither: the connector-instance store has no delete method (verified — only `upsert`, `ensureDefaultAccountConnection`, `get`, `getByBinding`, `listByOwner`, `resolveActiveByConnector`, `listActiveByConnector`, `updateStatus`, `setDisplayName`), and no browser owner-session route deletes a connection either.

The parent change (`add-owner-agent-control-surface`) deferred delete with a one-line reason: "needs `deleteConnection` + a defined cascade contract for records/dataset/spine/device source-instance." This change is that cascade contract. It is spec/design only. No destructive route is implemented here, because the cascade was not specified before now and implementing data loss against an unspecified cascade is exactly the unsafe-and-too-broad case the brief says to refuse.

All file:line evidence below was verified against the worktree at this commit.

## Goals / Non-Goals

**Goals:**

- Define precisely what `delete_connection` means, distinct from the three adjacent destructive/lifecycle semantics it is easily confused with.
- Specify the cascade over every table that references a connection, with explicit erasure (not implied) and an explicit preserve list.
- Specify the safety invariants the brief requires: connection-scoped blast radius, typed idempotency, typed foreign/unknown handling, default-account and device-collected handling, and no silent re-materialization.
- Specify the store primitive and route contracts a future lane implements, plus the full acceptance-test matrix that gates any catalog flip.

**Non-Goals:**

- Do not implement the delete route, the store method, or the catalog flip to `supported`. This change is the contract; a later lane is the implementation + proof.
- Do not reuse a device-scoped primitive (`revokeDevice`) for a connection-scoped action. `revokeDevice` cascades to every `device_source_instances` row and conditionally to `connector_instances` under one device — sibling-overreach by construction. Delete is keyed on exactly one `connection_id`.
- Do not weaken `/mcp` owner-bearer rejection.
- Do not redefine `revoke_connection`, grant-package revoke, or retention policy.

## The four adjacent semantics — delete is exactly one

The brief requires delete to be kept distinct from revoke, grant revocation, retention policy, and provider-credential revocation. The reference already has these as separate primitives; this change names delete as a fifth, and states what it does and does NOT subsume.

| Semantic | Primitive (today) | Touches records? | Touches the config row? | Reversible by |
| --- | --- | --- | --- | --- |
| **Stop future collection** (`revoke_connection`) | `updateStatus(id, {status:'revoked'})` (`connector-instance-store.js:343`/`:520`) + durability guard | No | Soft (status flip, row + `revoked_at` retained) | Explicit owner re-initiate |
| **Revoke PDPP disclosure grant** (`revokeGrantPackage`, owner-session only) | grant-package cascade over `grant_packages`/tokens/members | No (revokes *client access*, not data) | No (not a connection) | Re-issue grant |
| **Data-retention policy** | retention classification on records (`get-retained-by-connector-instance.sql`) | Governs lifecycle, not an owner action | No | n/a (policy, not an action) |
| **Source/provider credential revocation** | provider-side (owner logs out at Amazon/Google); device cred via `revokeDevice` (device-scoped) | No | No (or device-wide, not connection-scoped) | Re-authenticate at provider |
| **Delete a connection** (`delete_connection`, THIS change) | `deleteConnection(connectionId)` (new) | **Yes — erases this connection's records** | **Hard — removes the config row** | **Not reversible. Owner re-initiates a fresh connection (new `connection_id`).** |

The load-bearing distinction: **revoke stops the future and preserves the past; delete erases the past and removes the configuration.** Revoke ≠ forget. Delete = forget this connection and its data. They are deliberately separate owner actions with separate catalog families, separate routes, and separate audit event types.

## What `delete_connection` means (the chosen semantics)

`delete_connection(connection_id)` is the **connection-scoped purge**: it removes the configured connection row AND erases the collected data, history, search derivatives, blob bindings, schedule, and active-run lease for exactly that one `connection_id`, and clears (does not delete) the device-source-instance soft-reference to it. It preserves the audit spine, all sibling connections, all other devices, and all disclosure grants.

This is the only honest meaning given how reads work. The grant-scoped record read filters on `connector_instance_id` (`list-stream-visible-candidates.sql`: `WHERE connector_instance_id = ? AND stream = ?`). Therefore:

- **"Delete the config row only" is rejected.** Deleting only the `connector_instances` row would leave the still-`connector_instance_id`-keyed records readable through the grant surface, and would orphan the `connector_schedules` / `controller_active_runs` rows (PK `connector_instance_id`). That is silent under-deletion — the owner asked to delete a connection and its data survives. Forbidden.
- **"Disable future collection only" is rejected** — that is precisely `revoke_connection`, which already shipped. Delete must do more or it is a duplicate.
- **"Delete records/history/blobs only, keep the row" is rejected** — it leaves a dangling active config that re-collects on the next run, which is not a delete.
- **"Delete device-source-instance rows" is rejected as the *primary* meaning** — a `device_source_instances` row is a device↔binding edge owned by the device lifecycle (`ON DELETE CASCADE` from `device_exporters`), shared-shaped across connections on one device. Delete clears its nullable `connector_instance_id` back-reference so it no longer points at a gone connection, but does not delete the device edge (that is device de-enrollment, a different action). See cascade table row.
- **"Delete spine/audit history" is rejected.** `spine_events` has no `connector_instance_id` column (verified: it keys on `object_id`/`source_id`/`object_type`/`actor_id`). The audit trail is the durable evidence that collection, revocation, and *this deletion* happened. Erasing it would destroy the auditability primitive PDPP Core lists as load-bearing (`full-context-refresh.md` boundary map). Delete PRESERVES spine and APPENDS an `owner_agent.connection.delete` event.

So the named combination is: **erase collected data + derived state + config row for one `connection_id`; clear the device back-reference; preserve audit, siblings, devices, and grants.**

## Cascade specification (verified against the schema at this commit)

`connector_instances` PK is `connector_instance_id` with `UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)` and `FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT` (`server/db.js:169-183`). No table declares a real FK to `connector_instances`; every reference below is a soft (application-enforced) reference keyed on the `connector_instance_id` value, so the cascade is application code in a single transaction, not DB `ON DELETE`.

| Table | Ref column | Kind | Delete action | Evidence |
| --- | --- | --- | --- | --- |
| `records` | `connector_instance_id NOT NULL` | soft, `UNIQUE(connector_instance_id, stream, record_key)` | **ERASE** all rows for the id (all streams) | `server/db.js:695-707` |
| `record_changes` | `connector_instance_id NOT NULL` | soft, `PRIMARY KEY(connector_instance_id, stream, version)` | **ERASE** all rows for the id | `server/db.js:715-725` |
| `version_counter` | `connector_instance_id` | soft, `ON CONFLICT(connector_instance_id, stream)` | **ERASE** all rows for the id | `postgres-records.js:632-634` |
| `blobs` / blob bindings | `connector_instance_id` | soft, `PK(blob_id, connector_instance_id, stream, record_key, json_path)` | **ERASE** all rows for the id | `server/db.js:786` |
| `lexical_search_index` / `lexical_search_meta` | `connector_instance_id` | soft | **ERASE** all rows for the id | `postgres-search.js:28-56` |
| `semantic_search_blob` / `_meta` / `_backfill_progress` | `connector_instance_id` | soft | **ERASE** all rows for the id | `postgres-search.js:97-113` |
| `connector_attention_records` | `connector_instance_id` | soft, indexed | **ERASE** all rows for the id | `server/db.js:886-889` |
| `connector_schedules` | `connector_instance_id` | soft, **PK** | **ERASE** the row (else orphaned) | `server/db.js:468-476` |
| `controller_active_runs` | `connector_instance_id` | soft, **PK** | **ERASE** the row; delete MUST refuse while a run is active (see invariant I7) | `server/db.js:478-488` |
| `device_source_instances` | `connector_instance_id` (nullable) | soft, no FK to instances; FK on `device_id ON DELETE CASCADE` | **CLEAR** the back-reference (`SET connector_instance_id = NULL`), do NOT delete the device edge | `server/db.js:340-363` |
| `connector_instances` | (the row itself) | PK | **DELETE** the row last, in the same transaction | `server/db.js:169-183` |
| `spine_events` | none (`object_id`/`source_id`) | n/a | **PRESERVE**; append `owner_agent.connection.delete` | `server/db.js:900-920` |
| sibling connections / other devices | n/a | n/a | **UNTOUCHED** | — |
| `grant_packages` / disclosure grants | n/a | n/a | **UNTOUCHED** (delete a connection ≠ revoke a client grant) | — |

A connection-scoped, all-streams records purge keyed on `connector_instance_id` is fully expressible: every records-family table is keyed on it. The existing delete queries are split into **by-connector** (`WHERE connector_id = ?`, used only by manifest-fingerprint reconcile — connector-WIDE, the wrong scope for delete) and **by-stream** (`WHERE connector_instance_id = ? AND stream = ?`, used by per-stream cleanup, e.g. `postgres-records.js:1102-1131`). The new primitive adds the missing **by-instance, all-streams** delete (enumerate this id's streams, delete each table's rows for the id) so it never widens to `connector_id`. Reusing `deleteAllRecordsForConnector` (connector-wide) would over-delete sibling connections of the same connector type and is explicitly forbidden.

## Safety invariants (normative; each maps to a spec scenario)

- **I1 — connection-scoped blast radius.** Every write the cascade performs is filtered by exactly one `connector_instance_id`. No statement keys on `connector_id`, `device_id`, `owner_subject_id`, or `connector_schedules.connector_id` alone. Two connections of the same connector type, or two connections on the same device, are independent: deleting one leaves the other fully intact and collectable.
- **I2 — explicit erasure, not implied.** The set of erased tables is the cascade table above, enumerated, not "whatever has a matching column." Records, changes, version counters, blobs, search indices, attention records, schedule, and active-run lease are erased. Anything not listed is preserved by default. A future table that gains a `connector_instance_id` column is NOT auto-erased until this contract is updated to list it.
- **I3 — audit preserved.** `spine_events` is never deleted. Delete APPENDS one `owner_agent.connection.delete` event (and emits failure events). The audit trail of a connection survives the connection's deletion.
- **I4 — typed idempotency.** Deleting an already-deleted / unknown `connection_id` returns a typed, non-crashing result. The chosen shape: a second delete of the same id returns `connection_not_found` (404) — the row is gone, so it is indistinguishable from never-existed, and that is the honest answer. (Contrast revoke, whose repeat is `connector_instance_inactive` 400 because the row persists.) A delete that finds the row deletes it and returns 200/204 with a deletion summary.
- **I5 — typed foreign/unknown handling.** A `connection_id` owned by another subject returns 404 (never a cross-owner delete, never a 403 that leaks existence). An unknown id returns 404. Ownership is resolved through `resolveOwnerConnectorInstanceNamespace` (verifies `instance.ownerSubjectId === ownerSubjectId`) BEFORE any cascade write — same guard run-now and revoke use. A foreign id can never reach the cascade.
- **I6 — default-account no-resurrection.** For `source_kind:'account'` / `source_binding_key:'default'` connections, the durability concern that bit revoke applies harder to delete: after the row is gone, the NEXT owner read with `allowDefaultAccount:true` would call `ensureDefaultAccountConnection`, which (no row found) materializes a FRESH active row under the same deterministic id (`makeDefaultAccountConnectorInstanceId`) — silently resurrecting a connection the owner deleted, now with zero records. This is silent re-materialization, forbidden by the brief. Delete MUST prevent it. Two acceptable constructions, decided below (Decision 1): (a) a tombstone the materialization path respects, or (b) delete is only offered for non-default-account connections until a tombstone exists, with default-account delete typed `unsupported` with that exact reason. The contract REQUIRES that a deleted connection does not re-materialize without an explicit owner re-initiate.
- **I7 — no delete under an active run.** `controller_active_runs` PK is `connector_instance_id`; an in-flight run holds the lease and is mid-write. Delete MUST refuse with a typed `connection_run_active` (409) when an active-run lease exists for the id, rather than racing the run's writes. The owner stops/awaits the run, then deletes. (Revoke does not need this because it only flips status; delete erases rows a live run is writing.)
- **I8 — transactional all-or-nothing.** The cascade executes in one transaction. A mid-cascade failure rolls back: either the connection and all its data are gone, or nothing changed. No half-deleted connection (row gone, records orphaned, or vice versa).
- **I9 — `/mcp` unaffected.** Delete is REST-control-plane only, `requireToken` + `requireOwner`. `/mcp` continues to reject owner bearers. The data plane gains no delete authority.
- **I10 — grants untouched.** Deleting a connection does not revoke, narrow, or rewrite any disclosure grant. A grant scoped to that connector type simply reads zero records for the deleted connection afterward (the records are gone). Grant lifecycle stays owner-session `revokeGrantPackage`, never an owner-agent connection action.

## Typed errors

All over the shared `pdpp/common/PdppError` envelope the parent change established.

- `connection_not_found` (404) — unknown id, already-deleted id, or foreign-owner id (I4/I5). Existence is not leaked across owners.
- `ambiguous_connection` (409) — connector-only `DELETE /v1/owner/connectors/{connector_id}` with ≥2 active connections; carries `available_connections` + `retry_with:"connection_id"` (reuses the existing `AmbiguousConnectionError` envelope). Single active → auto-select.
- `connection_run_active` (409) — an active-run lease exists for the id (I7). Reason names that the owner must stop/await the run first.
- `default_account_delete_unsupported` (typed `unsupported` in the catalog, OR a 409 at the route) — only if Decision 1 picks construction (b); names the tombstone gap (I6).
- `authentication_error` (401) — missing bearer. `authorization_error` (403) — client / `mcp_package` bearer (audited). Owner bearer on `/mcp` → 403 (re-pin).

## Decisions

1. **Default-account resurrection guard: tombstone the deterministic id (preferred), else type it `unsupported`.** The deterministic default-account id means a deleted default-account connection is re-creatable byte-for-byte by the materialization path, which would silently undo the delete (I6). The preferred construction is a **tombstone**: record the deleted default-account binding (e.g. a `deleted` status the row retains instead of a hard row removal for the default-account class, OR a small `deleted_connector_instances` ledger keyed on the deterministic id) that `ensureDefaultAccountConnection` reads and refuses to resurrect — exactly mirroring the revoke durability guard's "return the row unchanged" rule, extended to "do not re-materialize a tombstoned binding." If the implementing lane judges the tombstone too broad for its tranche, the honest fallback is: hard-delete is supported for device-collected (`local_device`/`browser_collector`) and non-default `account` connections, and default-account delete stays typed `unsupported` with reason naming the tombstone primitive. Either way, **no deleted connection silently re-materializes.** This decision is the genuine open construction work and is why delete is its own change, not a one-line store method.

2. **Hard row removal for non-default classes; tombstone-or-defer for default-account.** Device-collected and explicit `account` (non-default) connections have non-deterministic binding keys, so hard-deleting the row does not collide with an auto-materialization path — the device re-enrolls under a fresh binding (a new `connection_id`), which is the correct "owner re-initiates" path. These can hard-delete safely. The default-account class is the only one needing the tombstone because its id is deterministic.

3. **Delete shares no destructive primitive (there is none to share); it adds one, scoped by construction.** Unlike rename/run/revoke, delete cannot follow "share the session semantic under a bearer adapter" — no session delete exists. The new `deleteConnection` store method and the new by-instance-all-streams records purge are genuinely new code. They are scoped by construction (every statement keyed on one `connector_instance_id`, I1) and transactional (I8). This is why the contract must precede the code.

4. **Route is `DELETE /v1/owner/connections/{connection_id}` + connector-only sibling.** Mirrors revoke/run exactly: `requireToken` + `requireOwner`, ownership resolved before mutation, connector-only auto-select-or-409-ambiguous, `owner_agent.connection.delete` audit. Idempotency per I4. Active-run refusal per I7.

5. **Catalog flip is gated on the full acceptance matrix.** `delete_connection` flips `unsupported → supported` only in the same reviewable unit as the route + store primitive + the complete test matrix below. Until then the catalog advertises it `unsupported` with a reason pointing at THIS contract (the no-runtime wording fix in this change updates that reason).

## Store primitive contract (future lane implements)

`deleteConnection(connectorInstanceId, { ownerSubjectId, now })` on both SQLite and Postgres connector-instance stores:

- Resolve the row; if absent or `ownerSubjectId` mismatches → throw `connector_instance_not_found` (caller maps to 404). Never delete another owner's row.
- In one transaction: erase the records-family tables and search/attention/schedule/active-run rows for exactly this `connector_instance_id` (cascade table), `SET connector_instance_id = NULL` on `device_source_instances` rows pointing at it, then delete the `connector_instances` row (or tombstone it for the default-account class per Decision 1).
- Refuse with `connector_instance_run_active` if `controller_active_runs` has a row for the id (I7).
- Return a non-secret deletion summary: `{ connection_id, connector_id, source_kind, deleted_record_count, deleted_stream_count, schedule_deleted, device_refs_cleared }` for the audit event and route response. No record contents, no secrets.
- Add the by-instance-all-streams delete queries under `server/queries/records/delete/` (`delete-records-by-connector-instance.sql` etc., `WHERE connector_instance_id = ?`), parallel to the existing by-stream set, so the records purge never widens to `connector_id`.

## Route contract (future lane implements)

`DELETE /v1/owner/connections/{connection_id}` and connector-only `DELETE /v1/owner/connectors/{connector_id}`:

- `requireToken` + `requireOwner`. Resolve ownership via `resolveOwnerConnectorInstanceNamespace(..., allowDefaultAccount:false)` before any mutation (I5).
- Connector-only: auto-select sole active connection, or typed `ambiguous_connection` (409) with `available_connections` + `retry_with`.
- Success → 200 with the deletion summary (or 204; 200-with-summary preferred so the agent can confirm what was erased).
- Idempotency I4; active-run refusal I7; default-account handling per Decision 1.
- Emit non-secret `owner_agent.connection.delete` spine evidence on success and every failure (actor kind, client id/name, target `connection_id`/`connector_key`, selector, `operation:'delete'`, outcome, deletion summary counts, request id; never the bearer, never record contents).

## Required acceptance-test matrix (gates the catalog flip)

- **Cascade completeness:** seed a connection with records across ≥2 streams, record_changes, blobs, search index rows, a schedule, and a device-source-instance back-reference → delete → assert every cascade-table row for the id is gone, the device row's `connector_instance_id` is NULL, the device row itself still exists, and the `connector_instances` row is gone.
- **No-sibling-overreach (I1):** two connections of the same connector type with records → delete one → the other's row, records, schedule, and collectability are intact. Repeat for two connections on the same device.
- **Records actually unreadable after delete:** a grant scoped to the connector type reads the deleted connection's records before delete and zero after (revoke ≠ delete contrast: a revoked connection's records stay readable; a deleted connection's do not).
- **Audit preserved (I3):** `spine_events` for the connection (collection runs, the revoke if any) survive, and a new `owner_agent.connection.delete` event is appended with the deletion summary and no secrets.
- **Idempotency (I4):** delete twice → first 200/summary, second 404 `connection_not_found`.
- **Foreign / unknown (I5):** foreign-owner id → 404; unknown id → 404; never cross-owner deletion.
- **Default-account no-resurrection (I6):** delete a default-account (github-style) connection → a subsequent dashboard summary read and an `allowDefaultAccount:true` owner resolution do NOT re-materialize it active with zero records (the test that drives Decision 1).
- **Active-run refusal (I7):** delete while an active-run lease exists → 409 `connection_run_active`; no rows erased.
- **Transactional (I8):** inject a mid-cascade failure → assert full rollback (connection and all data still present).
- **Grants untouched (I10):** delete → disclosure grants for the connector type are unchanged (status, scope, members).
- **Auth:** missing bearer → 401; client / `mcp_package` bearer → 403 (audited); owner bearer on `/mcp` → 403 (re-pin owner-bearer rejection).
- **Revoked owner-agent credential:** a revoked owner-agent bearer cannot delete (401), mirroring the revoke suite.
- **Connector-only ambiguity / auto-select:** ≥2 active → 409 `ambiguous_connection` + `available_connections` + `retry_with`; single active → auto-select.
- **Catalog:** `GET /v1/owner/control` and each connection's `supported_actions` advertise `delete_connection: supported` with the correct method/URL ONLY after route + store + matrix land.

## Risks / Trade-offs

- **Risk: delete erases more than the owner intended.** Mitigation: explicit enumerated cascade (I2), connection-scoped filter on every statement (I1), transactional rollback (I8), and a deletion-summary response so the owner/agent sees exactly what was erased.
- **Risk: delete erases less than intended (orphaned readable records).** Mitigation: the cascade erases the records-family tables keyed on `connector_instance_id`, the same key the grant read filters on, so post-delete reads return zero. The "config row only" non-option is explicitly rejected.
- **Risk: silent re-materialization of a deleted default-account connection.** Mitigation: Decision 1 (tombstone or typed-unsupported); the I6 test gates the flip.
- **Risk: delete races a live run.** Mitigation: I7 refusal on an active-run lease.
- **Risk: implementing before the cascade is agreed.** Mitigation: this change ships zero destructive runtime; the route/store/flip are a later gated lane.

## Migration / Rollout

1. Land this contract (spec deltas + the one-line catalog-reason wording fix). No runtime behavior changes.
2. Future lane, smallest-first: (a) the by-instance-all-streams records purge queries + `deleteConnection` store primitive + Decision-1 default-account guard, with the store/cascade tests; (b) the `DELETE /v1/owner/connections/{connection_id}` route + connector-only sibling + reference-contract ops + the route test matrix; (c) the catalog flip `unsupported → supported` in the same unit as (b).
3. Rollback is route-level: the catalog descriptor returns to `unsupported`; the store primitive is dormant if unrouted.

## Open Questions

- **Decision 1 construction (tombstone vs defer default-account).** Recorded as a decision with two acceptable answers; the implementing lane picks based on whether a tombstone ledger is in-tranche. The contract's hard requirement ("no silent re-materialization") holds either way. This is the one genuinely open construction choice and the reason delete is its own spec-first change.
- **Should delete offer a `purge_records: false` mode (drop config, keep records)?** Deferred. The default and only mode in this contract is full purge, because "keep records but drop the connection" leaves records keyed on a gone `connector_instance_id` with no owner-facing way to address them — a worse orphan than the one delete fixes. If a future retention/export use case needs "detach records from a connection," it gets its own change defining where detached records live.
