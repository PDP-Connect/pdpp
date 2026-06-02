## Context

The archived `add-static-secret-owner-connect-primitive` change established the
durable primitives for static-secret connections (encrypted per-connection
credential store, owner-session capture route, connection-scoped subprocess
injection) and a normative requirement that the **first** connection materialize
only after owner capture and first ingest, with **no** `connector_instances` row
written by the intent beforehand. That requirement is currently unimplemented:
the only server-side way to materialize a static-secret connection is
`ensureDefaultAccountConnection`, which writes a phantom `active` zero-record
row, and the capture route refuses any non-`active` instance.

This change adds the minimal lifecycle primitive — a `draft` instance status —
that makes the requirement real.

### Grounding facts (verified in tree, `reference-implementation/`)

- `server/stores/connector-instance-store.js:9`:
  `VALID_STATUSES = new Set(['active', 'paused', 'revoked'])`. Used by
  `normalizeRecord` and `updateStatus` to reject unknown statuses.
- `server/db.js:173` and the `migrate*` rebuild blocks: the SQLite
  `connector_instances.status` column carries
  `CHECK (status IN ('active', 'paused', 'revoked'))`. The Postgres arm
  (`server/postgres-storage.js`) has no status CHECK but inserts via the same
  normalized record.
- `resolveOwnerConnectorInstanceNamespace` (`store.js:203`) throws
  `connector_instance_inactive` when an explicitly addressed instance is not
  `active` (`store.js:256`). This is the single status gate for the
  capture/run/ingest resolution path; `resolveActiveByConnector` and
  `listActiveByConnector` already filter `status = 'active'` in SQL.
- Read surfaces that enumerate instances go through `listByOwner` (no status
  filter): `/_ref/connections`, `/_ref/connector-instances`
  (`ref-connectors.ts:362,400`), the dashboard (`ref-control.ts:771`), owner
  connection templates (`owner-connector-templates.ts:214`), owner connections
  (`owner-connections.ts:339`), and device-exporter listing
  (`ref-device-exporters.ts:779`). All of these apply their own status filters
  only at the projection layer (e.g. `!status || instance.status === status`),
  which would **show** drafts.
- Controller `runNow` / `validateRunNowPreconditions` (`controller.ts:3007`)
  checks only the manifest and the active-run lock — **not** instance status.
  The status gate lives entirely in the HTTP resolver. A draft can therefore be
  run by the controller once its `connectorInstanceId` is handed in.
- RS ingest: `operations/rs-records-ingest/executeRecordsIngest` returns
  `records_accepted`. The host adapter `mountRsRecordsIngest`
  (`server/routes/rs-mutation.ts:821`) resolves the storage namespace at
  `rs-mutation.ts:846`/`855` via `resolveOwnerConnectorNamespace(req, cid, {
  connectorInstanceId })` and is owner-bearer (`requireOwner`).
- The capture route (`server/routes/ref-static-secret-credentials.ts`) keys on
  an existing `connectorInstanceId` and resolves through
  `resolveOwnerConnectorNamespace(req, null, { connectorInstanceId,
  allowDefaultAccount: false })`.

## Goals / Non-Goals

Goals:

- Close the first-static-secret-connection deadlock with no phantom active row.
- Keep drafts invisible to every connection read surface by construction.
- Keep the owner-session-only and no-secret-leak invariants intact.
- Represent two mailboxes as two distinct `connection_id`s.
- Keep the change additive: no read contract field removed or renamed.

Non-Goals:

- The live-account end-to-end proof (real Gmail app password / GitHub PAT,
  live IMAP/API). Gated by the archived design's proof-before-flip rule.
- Flipping the `api_network` owner-agent intent branch or the catalog
  descriptor from `unsupported`.
- Any change to grant/agent read scoping, MCP, or client surfaces.

## Decisions

### 1. `draft` is a fourth instance status, reserved for static-secret setup

Add `'draft'` to `VALID_STATUSES`, the SQLite CHECK, and a forward CHECK-widening
migration (mirroring `migrateConnectorInstancesSourceKindBrowserCollector`,
`db.js:2575`; registered alongside it at `db.js:3106`). The migration is a no-op
once the constraint already names `'draft'`. The Postgres arm needs no DDL
migration (no status CHECK), but `normalizeRecord`/`updateStatus` admit `'draft'`
on both arms.

`draft` is **only** produced by the new owner-session draft-create route.
`ensureDefaultAccountConnection`, device enrollment, and every other
materialization path continue to write `active`. There is no transition into
`draft` from `active`/`paused`/`revoked`; the only transition **out** of `draft`
is `draft → active` on first ingest.

### 2. Invisibility is enforced at the store, not per-consumer

Rather than teach all six `listByOwner` consumers to filter `draft`, exclude
`draft` in `listByOwner` itself (default behavior). This is the single
choke point that makes drafts invisible to the dashboard, `/_ref/connections`,
`/_ref/connector-instances`, owner-agent connection reads, templates, and
device-exporter listings by construction. The run/search/read-by-connector
paths (`resolveActiveByConnector`, `listActiveByConnector`) already filter
`status = 'active'` in SQL, so drafts are excluded there too.

`get(connectorInstanceId)` and `getByBinding(...)` still return a draft row —
they are the owner-internal lookups the capture, draft-create, and ingest paths
need. They are not list/read surfaces.

A future "show me my in-progress setups" surface could opt in with an explicit
`includeStatuses` argument; this change does not add one (YAGNI), but the
default-exclude shape leaves room for it without re-auditing consumers.

### 3. `allowStatuses` is the narrow admission key; no agent path holds it

`resolveOwnerConnectorInstanceNamespace` gains an `allowStatuses` option
(default `['active']`). When an explicitly addressed instance's status is in
`allowStatuses`, the resolver returns it; otherwise it throws
`connector_instance_inactive` exactly as today. Only two callers pass
`['active', 'draft']`:

- the owner-session capture route, so the owner can seal a credential onto a
  draft; and
- the owner-bearer RS ingest host adapter, **only** when an explicit
  `connector_instance_id` is supplied (so first ingest can write into the
  draft).

The connector-only resolution path (`resolveActiveByConnector`) is unaffected —
it is active-only by SQL and never consults `allowStatuses`. No grant-scoped,
client, MCP, or owner-agent **read** resolution passes the option, so a draft is
never reachable as a read target. `allowDefaultAccount` and `allowStatuses` are
independent: the draft path passes `allowDefaultAccount: false`.

### 4. The owner-session draft route creates the row; capture seals onto it

`POST /_ref/connectors/:connectorId/draft-connection` (cookie-auth,
`requireOwnerSession`):

- rejects a non-static-secret connector with
  `409 static_secret_credential_unsupported` (reusing
  `STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR = {gmail, github}`);
- creates one `draft` instance via `store.upsert` with `sourceKind: 'account'`
  and a **random** `sourceBindingKey` (not the deterministic `'default'` key),
  so repeated calls create distinct drafts and two mailboxes become two
  `connection_id`s. The deterministic default-account id is deliberately avoided
  — it is the phantom-resurrection key (`makeDefaultAccountConnectorInstanceId`)
  and must not be reused for drafts;
- returns the new `connection_id` and a typed `next_step` pointing at the
  capture route;
- emits a non-secret audit event
  (`owner.connection.static_secret_draft.create`).

The owner then calls the existing capture route against that `connection_id`.
The only capture-route change is that its namespace resolution passes
`allowStatuses: ['active', 'draft']`, so a draft target is admitted. Everything
else (kind validation, no-secret audit, response metadata) is unchanged.

### 5. First successful ingest flips draft → active at the ingest boundary

Activation belongs where record acceptance is known and is owner-authenticated.
`mountRsRecordsIngest` already resolves the namespace and runs the operation; it
also already has `records_accepted` in `output.envelope`. After a successful
ingest, if the resolved instance was `draft` **and** `records_accepted > 0`,
call a new store primitive `activateDraft(connectorInstanceId, { now })` that
updates the row `draft → active` (and is a no-op if the row is not `draft`,
keeping it idempotent and safe under concurrent first runs).

Why the ingest boundary and not the controller run completion:

- The controller spawns the connector subprocess out-of-process; record counts
  are not available in the `runNow` promise. The connector POSTs records back to
  the RS ingest endpoint, which is exactly where acceptance is observed.
- A zero-record run (`records_accepted === 0`) never flips the draft, satisfying
  *"zero records leaves it draft/invisible"* without extra bookkeeping.
- A failed run never reaches a successful ingest, so the draft stays invisible.

The flip is keyed on `records_accepted > 0` for **this** ingest call. A draft
that has already activated (a later run) simply finds the row `active`; the
`activateDraft` no-op guard handles it.

### 6. Two mailboxes, two connection_ids

Because the draft route mints a random `sourceBindingKey` per call, two
draft-creates for `gmail` produce two distinct `connector_instance_id`s under
the `UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)`
constraint. Each gets its own credential (the store is already
instance-scoped), each ingests its own mailbox, each activates independently.
This is the construction the archived design's *"Two mailboxes hold two distinct
credentials"* requirement needs for the first-connection case.

### 7. No-secret-leak invariant is preserved

The draft route never accepts or returns a secret — it only creates a row. The
capture route's no-secret behavior is unchanged. Drafts are invisible to reads,
so a draft cannot become a new way to observe a secret. The activation flip
writes only a status + timestamp.

## Risks / Trade-offs

- **A draft is runnable before it has a credential.** A `draft` instance can be
  run (controller does not gate on status); if it has no credential, the run
  uses the legacy process-env path or fails to authenticate, accepts zero
  records, and the draft stays invisible. This is acceptable: it cannot create a
  phantom active row and cannot leak a secret. The expected owner flow is
  create-draft → capture → run, but an out-of-order run is fail-safe.
- **Orphaned drafts accumulate** if an owner creates a draft and never captures
  or never ingests. They are invisible, harmless, and deletable via the existing
  delete-connection path (a draft has a non-default random binding key, so it is
  not blocked by the default-account delete refusal). A future cleanup primitive
  could prune stale drafts; out of scope here.
- **Migration safety.** The CHECK-widening migration rebuilds the table; it is
  guarded by a `sql.includes("'draft'")` no-op check and runs inside a
  transaction, matching the established pattern. Existing rows are copied
  verbatim.

## Migration Plan

1. Land the store + DB + resolver + route + ingest changes behind no feature
   flag (additive; drafts are invisible until created).
2. The CHECK-widening migration runs on next boot; idempotent and no-op once
   applied.
3. No data backfill: no existing row is `draft`.

## Open Questions

- Should a stale-draft cleanup/TTL primitive ship with this change? Deferred:
  drafts are invisible and harmless; a cleanup primitive is a separate slice.
- Should the dashboard show an explicit "setup in progress" affordance for
  drafts? Deferred to a console lane; the backend leaves room via a future
  `includeStatuses` list option.

## Acceptance Checks

- `openspec validate add-static-secret-owner-session-connect-path --strict`.
- Draft is invisible on `/_ref/connections`, `/_ref/connector-instances`, and
  the dashboard listing.
- Capture seals a credential onto a draft via the owner session; bearer/agent
  paths cannot.
- First ingest with `records_accepted > 0` flips draft → active; zero-record or
  failed ingest leaves it draft.
- Two draft-creates for one connector yield two distinct `connection_id`s.
- No read surface returns the secret; the draft and activation audits carry no
  secret.
- Non-static-secret connector draft-create is rejected.
