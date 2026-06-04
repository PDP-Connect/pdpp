## Why

The archived `add-static-secret-owner-connect-primitive` change shipped the
per-connection encrypted credential store, the owner-session capture route, and
connection-scoped subprocess injection — but only for connections that **already
exist**. Its own spec (`reference-connector-instances` →
*"Connection materializes after owner capture and first ingest"*) requires that
the **first** static-secret connection materialize without writing a phantom
`connector_instances` row before capture and first ingest. That requirement has
no implementation: a first static-secret connection is a lifecycle deadlock.

The deadlock, verified in tree:

- The owner-session capture route
  (`POST /_ref/connections/:connectorInstanceId/static-secret-credential`)
  resolves the target through `resolveOwnerConnectorInstanceNamespace`, which
  rejects any instance that is not `active`
  (`connector_instance_inactive`). It can only seal a credential onto an
  **existing active** connection.
- A static-secret connection only materializes implicitly. The single way to
  create one server-side is `ensureDefaultAccountConnection`, which writes an
  `active`, zero-record `connector_instances` row — exactly the phantom
  default-account connection the owner has worked to eliminate
  (`cleanup-phantom-connections`, the console add-connection picker redesign).

So the owner cannot bring a **first** Gmail/GitHub connection into existence
through the owner session without either (a) hitting the inactive-instance
rejection, or (b) minting a phantom active zero-record row.

This change closes the deadlock with the smallest durable lifecycle primitive
that satisfies the existing spec requirement: a `draft` connector-instance
status used **only** for static-secret owner-session setup, invisible to every
connection read surface, that an owner-session route creates, the owner-session
capture route can seal a credential against, and the **first successful ingest**
flips to `active`. A failed run, a missing credential, or a zero-record run
leaves the row `draft` and invisible — no phantom active connection is ever
written.

## What Changes

- Add a fourth connector-instance status, **`draft`**, admitted by the store's
  `VALID_STATUSES`, the SQLite `connector_instances.status` CHECK constraint
  (with a forward CHECK-widening migration), and the Postgres arm. `draft` is
  reserved for static-secret owner-session setup; no other path creates it.
- Make `draft` instances **invisible by construction** to every connection read
  surface: the store's `listByOwner` excludes `draft` by default (covering
  `/_ref/connections`, `/_ref/connector-instances`, the dashboard, owner-agent
  connection reads, owner connection templates, and device-exporter listings),
  and the active-only resolution/run/search paths already exclude non-active
  statuses.
- Add a narrow resolver option **`allowStatuses`** (default `['active']`) on
  `resolveOwnerConnectorInstanceNamespace`. Only the owner-session capture path
  and the owner-bearer ingest path (when an explicit `connector_instance_id`
  addresses a draft) pass `['active', 'draft']`. No grant-scoped, client, MCP,
  or owner-agent **read** path passes it.
- Add an owner-session-only route
  **`POST /_ref/connectors/:connectorId/draft-connection`** that creates one
  `draft` instance for a static-secret connector (`gmail`/`github`) with a
  random per-draft source-binding key — so two mailboxes are two distinct
  `connection_id`s — and is refused (`409 static_secret_credential_unsupported`)
  for any non-static-secret connector.
- Allow the existing owner-session capture route to seal a credential against a
  `draft` target (via `allowStatuses`), with no change to bearer/agent paths.
- Flip a `draft` instance to `active` on the **first ingest that accepts at
  least one record**, at the RS ingest host boundary
  (`mountRsRecordsIngest`), via a new store primitive `activateDraft`. A failed
  run, missing credential, or zero-record run leaves the instance `draft` and
  invisible.
- Preserve the no-secret-leak invariant unchanged: the draft route and its audit
  carry only non-secret metadata; no read surface returns the secret.

The `api_network` owner-agent intent branch stays `unsupported` and is **not**
flipped here; that flip remains gated on the live end-to-end proof
(archived design Decision 6), which requires a real provider secret this lane
must not use.

## Capabilities

### Modified Capabilities

- `reference-connector-instances`: add the `draft` status, its read-surface
  invisibility, the owner-session draft-create primitive, draft-target capture
  admission, and first-ingest activation — as instance-lifecycle requirements
  that make the archived *"Connection materializes after owner capture and first
  ingest"* requirement implementable without a phantom active row.

## Impact

- Implementation area: `connector-instance-store.js` (SQLite + Postgres arms),
  `server/db.js` (CHECK-widening migration), the namespace resolver
  (`resolveOwnerConnectorInstanceNamespace` + host
  `resolveOwnerConnectorNamespace`), a new owner-session route, the RS ingest
  host adapter (`rs-mutation.ts`), and focused tests.
- No public contract field is removed; `draft` is additive and never surfaces on
  a read. The owner-bearer ingest path gains the ability to address a draft by
  explicit `connector_instance_id` (owner-only, already `requireOwner`).
- Downstream: this is the implementation of the archived primitive's
  first-connection requirement. The live-account end-to-end proof and the
  `api_network`/catalog flip remain the only follow-ups, still gated on a real
  secret.
