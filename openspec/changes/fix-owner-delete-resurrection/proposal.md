## Why

Live evidence, reproduced through the real store: owner-agent revoke and
delete both returned 200 for two Codex device-collected connections
(`cin_f3a61c7da034a13d555f0078`, `cin_7c1f805c48b81e749de102a6`); the owner
list confirmed both absent; durable `owner_agent.connection.revoke` /
`owner_agent.connection.delete` spine events exist at
`2026-07-25T15:22:18Z`. After a normal stack rebuild, `connector_instances`
for both again read `status = active`, `revoked_at = NULL`, and the strict
health audit sees them as live failures.

Root cause, proven against the real SQLite store
(`test/_repro-delete-resurrection.mjs`, discarded scratch script — the
committed regression lives in `test/connector-instance-store.test.js`):

1. `connectorInstanceId` is **deterministic**:
   `makeConnectorInstanceId` hashes `(ownerSubjectId, connectorId,
   sourceKind, sourceBindingKey)`. For a device-collected connection,
   `sourceBindingKey` derives from `{kind, local_binding_name}` only — it is
   independent of `device_id` / `source_instance_id`, by design, so a
   legitimate device reinstall can re-pair the same logical binding.
2. `deleteConnection` performs a **hard row delete**: the durable erasure
   cascade (records/history/blobs/schedule/device-back-ref) correctly
   removes the `connector_instances` row as its final step (spec
   requirement "Connection delete SHALL erase one connection's data and
   configuration"). Nothing durable records that this specific identity was
   ever owner-deleted.
3. `upsert` is `INSERT ... ON CONFLICT(owner_subject_id, connector_id,
   source_kind, source_binding_key) DO UPDATE SET status = excluded.status,
   ...`. Once the row is gone, this collapses to a bare `INSERT`: any later
   call that upserts the SAME identity — the device-exporter `/enroll`
   exchange (`server/routes/ref-device-exporters.ts`), reachable any time
   the owner (or, per the live incident, an unattended re-enroll) presents
   a fresh one-time enrollment code for the same `local_binding_name` —
   materializes a fresh row on the SAME `connector_instance_id`, `status:
   'active'`, `revoked_at: null`. There is no distinction, at that
   `upsert` call, between "this identity has never existed" and "this
   identity was owner-deleted five minutes ago."

The ONLY existing non-resurrection guard
(`ensureDefaultAccountConnection`'s "read the row first; a revoked row is
returned unchanged, never resurrected") covers exactly one case:
default-account (`sourceKind: 'account'`, binding key `'default'`)
connections, and only against **revoke** (the row still exists, so a
read-before-write guard works). Delete leaves no row for that guard to
read, and no equivalent guard exists for device-collected
(`local_device` / `browser_collector`) identities at all — this is a
systemic, connector-neutral gap in delete's durability, not a
Codex-specific defect.

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
it is write-mostly, has exactly ONE reader (`upsert`'s no-existing-row
path), and every other read surface in the system needs zero changes
because it never queries this table.

## What Changes

- **BREAKING (new fail-closed behavior):** `upsert` on a `connector
  instance store, when no live row exists for the target identity
  (`owner_subject_id, connector_id, source_kind, source_binding_key`)
  AND that identity was previously owner-deleted, throws a typed
  `ConnectorInstanceDeleteError('connection_tombstoned', ...)` instead of
  silently materializing an active row. This changes device-exporter
  `/enroll` and any other bare-`upsert` caller from "always succeeds" to
  "typed 409 for a tombstoned identity" — the correct, intentional
  behavior change this fix exists to make.
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
  reactivation of the SAME identity by any upsert path, generalized from
  the existing default-account-only guarantee).
- Affected code:
  - `reference-implementation/server/db.js` (new table, SQLite)
  - `reference-implementation/server/postgres-storage.js` (new table,
    Postgres)
  - `reference-implementation/server/stores/connector-instance-store.js`
    (tombstone write in `deleteConnection`'s cascade; tombstone check in
    `upsert`'s no-existing-row path, both backends)
  - `reference-implementation/server/routes/ref-device-exporters.ts`
    (surface `connection_tombstoned` as typed 409)
- No wire/protocol changes to revoke; delete's HTTP contract gains no new
  response shape (the 200 response is unchanged) — the new typed error
  surfaces only on a LATER `upsert` attempt against the deleted identity,
  not on the delete call itself.
- Explicit re-enrollment remains possible: an operator who wants to
  reconnect after an owner delete uses a distinct binding (a new
  `local_binding_name`, which the manifest/collector interaction already
  supports), which never collides with the tombstoned identity's binding
  key and therefore never consults the tombstone at all.
