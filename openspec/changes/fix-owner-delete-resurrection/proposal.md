## Why

Live evidence, reproduced through the real store: owner-agent revoke and
delete both returned 200 for two Codex device-collected connections
(`cin_f3a61c7da034a13d555f0078`, `cin_7c1f805c48b81e749de102a6`); the owner
list confirmed both absent; durable `owner_agent.connection.revoke` /
`owner_agent.connection.delete` spine events exist at
`2026-07-25T15:22:18Z`. **After a normal stack rebuild, `connector_instances`
for both again read `status = active`, `revoked_at = NULL`, and the strict
health audit sees them as live failures.**

### Definitive root cause: the startup local-device migration sweep, not re-enrollment

`migrateLocalDeviceConnectorInstances` (SQLite, `server/db.js`) and
`migratePostgresLocalDeviceConnectorInstances` (Postgres,
`server/postgres-storage.js`) run **unconditionally on every process boot**
(`initDb`/`bootstrapPostgresSchema`) — not a one-time upgrade. Their
top-of-function gate only checks that today's schema columns already exist;
once that is true (any fully-migrated deployment, i.e. every live
deployment), the function still runs its FULL scan of
`device_source_instances` on every single boot and re-upserts a
`connector_instances` row for every row it finds.

`deleteConnection`'s cascade clears ONLY
`device_source_instances.connector_instance_id`
(`clear-source-instance-connector-ref.sql`) — it deliberately leaves
`connector_id`, `local_binding_id`, `device_id`, `source_instance_id`,
`status`, and `display_name` populated, because the device edge and sibling
connections must survive the delete. That is exactly the row shape the
startup migration's own query selects
(`WHERE dsi.connector_id IS NOT NULL AND ... AND dsi.source_instance_id IS
NOT NULL`). With no live `connector_instances` row anywhere referencing the
identity (the delete just removed it), the migration falls through to a
bare `INSERT`, materializing the connection as `status: 'active',
revoked_at: NULL` — reproduced end to end through real `initDb()` boots
(no HTTP call, no re-enrollment, no test seam bypassing the real migration)
in `test/connector-instance-store.test.js`. **This is the "normal stack
rebuild" trigger the live incident describes**, and it requires zero owner
or operator action to fire — every subsequent restart re-triggers it.

Secondary detail (SQLite only, pre-existing, orthogonal to the resurrection
itself): the SQLite migration's binding-key derivation hashed the FULL
`{kind, device_id, local_binding_name, source_instance_id}` shape rather
than the canonical `{kind, local_binding_name}` identity `upsert`/the
tombstone table use, so a resurrected row could even land under a
DIFFERENT `connector_instance_id` than the one that was deleted. Irrelevant
to the owner-visible symptom (the deleted connection reappears, active,
either way) but was fixed in lockstep — see "What Changes".

### Secondary, independently reachable path: device-exporter re-enrollment

`connectorInstanceId` is **deterministic**: `makeConnectorInstanceId`
hashes `(ownerSubjectId, connectorId, sourceKind, sourceBindingKey)`. For a
device-collected connection, `sourceBindingKey` derives from `{kind,
local_binding_name}` only — independent of `device_id`/`source_instance_id`
by design, so a legitimate device reinstall can re-pair the same logical
binding. `deleteConnection` performs a **hard row delete** as the final
step of its (correct, already-tested) transactional erasure cascade, and
`upsert` is `INSERT ... ON CONFLICT(...) DO UPDATE`, which collapses to a
bare `INSERT` once the row is gone. A later device-exporter `/enroll`
exchange for the same `local_binding_name` — reachable whenever a fresh
one-time enrollment code is presented for that binding — hits the exact
same bare-INSERT path as the startup migration and resurrects the
connection the same way. This is a REAL, independently reachable
resurrection path (proven by its own route-level regression test in
`test/device-exporter-routes.test.js`), but it requires an explicit
enrollment-code exchange to trigger — the startup migration above is the
trigger that fires on every boot with zero action, and is therefore the
higher-confidence explanation for a "stack rebuild" incident report.

Both paths share the identical underlying defect and the identical fix: no
durable record exists anywhere that a given identity was owner-deleted, so
any write path materializing a fresh row for that identity cannot
distinguish "never existed" from "owner-deleted five minutes ago."

The ONLY pre-existing non-resurrection guard
(`ensureDefaultAccountConnection`'s "read the row first; a revoked row is
returned unchanged, never resurrected") covers exactly one case:
default-account (`sourceKind: 'account'`, binding key `'default'`)
connections, and only against **revoke** (the row still exists, so a
read-before-write guard works). Delete leaves no row for that guard to
read, and no equivalent guard existed for device-collected (`local_device`
/ `browser_collector`) identities, on ANY write path, at all — this is a
systemic, connector-neutral gap in delete's durability, not a
Codex-specific or re-enrollment-specific defect.

### Investigated and ruled out: table-based tombstone vs. reusing `connector_instances`

Per design direction, reusing the existing lifecycle row (a new terminal
`deleted` status on `connector_instances`, analogous to the existing
`draft` status hidden from `listByOwner`) was evaluated FIRST, before
adding a new table.

This is unsafe without a much larger audit than this fix's scope justifies.
Unlike `draft` — which is hidden behind exactly one choke point
(`READ_SURFACE_HIDDEN_STATUSES` inside `listByOwner`) — `connector_instances`
has multiple **unfiltered, status-blind** full-table and by-id reads that
already exist for other reasons:

- `connector-summary-evidence-engine.ts`'s unscoped discovery read
  (`SELECT * FROM connector_instances ORDER BY connector_instance_id ASC`,
  both SQLite and Postgres arms) treats every row as a live connection for
  health/summary-evidence reconciliation — it was deliberately widened to
  read every subject's rows (see its own comment on Sol P1.3) specifically
  so it would not miss a real connection.
- `records.js`'s manifest-generation joins, `connector-state-store.ts`'s
  `manifest_generation` lookups, and `record-source-checkpoint.ts` read
  `connector_instances` by id with no status filter.
- The startup migration sweeps THEMSELVES read `connector_instances`
  broadly to resolve legacy/existing bindings — the very mechanism that
  turned out to be the definitive resurrection trigger.

A `deleted`-status row left in place would need every one of these
call sites individually audited and patched to exclude it, or a deleted
tombstone risks leaking back into health projections, summary evidence, or
manifest-generation joins — the exact class of "silently wrong health
read" this fix exists to close. That is a larger, riskier surface than the
task warrants, and the existing delete spec already ratifies "it SHALL
remove the connection's configured `connector_instances` row" (`reference-
connector-instances` spec, "Connection delete SHALL erase one connection's
data and configuration") — keeping a row, even an emptied one, would need
that requirement rewritten, further widening the change.

A separate, minimal, identity-only tombstone table is smaller and safer:
it is write-mostly, has a SMALL, ENUMERATED set of readers (`upsert`'s
no-existing-row path in both the store and both startup migrations), and
every other read surface in the system needs zero changes because it never
queries this table.

## What Changes

- **BREAKING (new fail-closed behavior):** `upsert` on a connector
  instance store, when no live row exists for the target identity
  (`owner_subject_id, connector_id, source_kind, source_binding_key`)
  AND that identity was previously owner-deleted, throws a typed
  `ConnectorInstanceDeleteError('connection_tombstoned', ...)` instead of
  silently materializing an active row. This changes device-exporter
  `/enroll` and any other bare-`upsert` caller from "always succeeds" to
  "typed 409 for a tombstoned identity."
- **The startup local-device migration sweep (both backends) now consults
  the SAME tombstone table before its bare-INSERT path and SKIPS (does not
  resurrect, does not throw — this is a background reconciliation sweep,
  not an owner-facing request) any row whose computed identity is
  tombstoned.** This is the fix for the actually-observed "stack rebuild"
  trigger.
- **The SQLite migration's binding-key derivation now uses the SAME
  canonical `{kind, local_binding_name}` shape as `upsert`/the tombstone
  table** (imported from the shared `connector-instance-utils.ts` module,
  replacing a local duplicate that hashed the wrong, over-specific shape),
  matching what the Postgres migration already did correctly. This is
  required for the migration's tombstone check to find the SAME identity
  delete recorded, not a different id.
- Add a minimal `connector_instance_tombstones` table (SQLite + Postgres),
  keyed on the exact same identity axis as `connector_instances`'
  `UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)`
  constraint. One row per owner-deleted identity; no configuration,
  secrets, or record data — `connector_instance_id`, the four identity
  columns, and `deleted_at`.
- `deleteConnection`'s existing single cascade transaction now also writes
  one tombstone row (idempotent `INSERT ... ON CONFLICT DO NOTHING`,
  keyed on identity) immediately before removing the `connector_instances`
  row — same commit, same all-or-nothing guarantee already proven by the
  existing I8 atomicity tests.
- `upsert`, on the no-existing-row path only (a real `ON CONFLICT DO
  UPDATE` hit is untouched — an existing live row's status transitions,
  including revoke → reactivate-by-re-enroll, are unchanged), consults the
  tombstone table for the target identity and fails closed with
  `connection_tombstoned` if a tombstone exists.
- **Postgres `upsert` is now coordinated through the SAME per-identity
  `withConnectorInstanceWrite` gate `deleteConnection` already uses**,
  closing a delete/upsert TOCTOU: without this, a concurrent delete and
  upsert for the same identity could interleave between the tombstone
  check and the INSERT. `withConnectorInstanceWrite`'s Postgres path
  acquires a REAL `pg_try_advisory_lock` — exclusion enforced by the
  Postgres server across connections/processes, not merely an in-process
  mutex — proven by a genuine two-OS-process discriminator
  (`test/connector-instance-delete-upsert-two-process-race.test.js`), not
  just concurrent async calls within one process. SQLite's `upsert` is
  deliberately left uncoordinated: better-sqlite3 is synchronous and
  single-connection per process, so there is no genuine multi-process race
  on that backend, and wrapping a synchronous method in the async
  coordinator would silently break every existing sync-assuming caller for
  no safety benefit.
- Device-exporter `/enroll` (`server/routes/ref-device-exporters.ts`)
  surfaces `connection_tombstoned` as a typed 409 telling the operator the
  binding was owner-deleted and needs a distinct rebind (e.g. a new
  `local_binding_name`), instead of the enrollment succeeding and then
  behaving like nothing happened.
- `ensureDefaultAccountConnection`'s existing revoke-durability guard is
  unchanged (it still short-circuits on a live revoked row before ever
  reaching `upsert`); it is now additionally covered by the same
  tombstone check on its own `upsert` call for the delete case — today
  default-account delete is refused outright
  (`default_account_delete_unsupported`), so this is currently unreachable
  for that path, but it keeps the two guards from silently diverging if
  default-account delete is ever enabled.
- No change to revoke, no change to any read surface, no change to the
  shape or semantics of any existing status value or the delete cascade's
  data-erasure contract.

## Impact

- Affected specs: `reference-connector-instances` (new requirement: owner
  deletion is a durable, restart-surviving fact that blocks silent
  reactivation of the SAME identity by any upsert or startup-reconciliation
  path, generalized from the existing default-account-only guarantee).
- Affected code:
  - `reference-implementation/server/db.js` (new table, SQLite;
    tombstone-aware `migrateLocalDeviceConnectorInstances`; canonical
    binding-key derivation via `connector-instance-utils.ts`)
  - `reference-implementation/server/postgres-storage.js` (new table,
    Postgres; tombstone-aware `migratePostgresLocalDeviceConnectorInstances`)
  - `reference-implementation/server/stores/connector-instance-store.js`
    (tombstone write in `deleteConnection`'s cascade; tombstone check in
    `upsert`'s no-existing-row path, both backends; per-identity write
    coordination on Postgres `upsert`)
  - `reference-implementation/server/routes/ref-device-exporters.ts`
    (surface `connection_tombstoned` as typed 409)
- No wire/protocol changes to revoke; delete's HTTP contract gains no new
  response shape (the 200 response is unchanged) — the new typed error
  surfaces only on a LATER `upsert`/migration-sweep attempt against the
  deleted identity, not on the delete call itself.
- Startup migration sweeps become silently no-op for a tombstoned identity
  (skip, do not throw) — this is intentional: a background reconciliation
  pass encountering a legitimately owner-deleted binding is not an error
  condition, unlike an owner-initiated `/enroll` hitting the same
  tombstone, which IS surfaced as a typed 409 to the caller.
- Explicit re-enrollment remains possible: an operator who wants to
  reconnect after an owner delete uses a distinct binding (a new
  `local_binding_name`, which the manifest/collector interaction already
  supports), which never collides with the tombstoned identity's binding
  key and therefore never consults the tombstone at all.
