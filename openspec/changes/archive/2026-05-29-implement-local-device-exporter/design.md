## Context

`design-local-device-exporter-collection` selected a push-first topology: a local device agent runs a connector near device-local files, then pushes normalized records to a remote reference instance. The first implementation target is Codex because it is the strongest dogfood path and exercises both rollout JSONL and read-only SQLite state.

Current connector ingestion assumes the reference server owns the connector runtime. That does not work for serverless or remotely hosted deployments where local files remain on the owner's laptop. A naive HTTP ingest path keyed only by `connector_id + stream + record_key` would conflate multiple devices and create silent data corruption.

## Goals / Non-Goals

**Goals:**

- Provide a reference-only local device exporter for Codex.
- Keep device credentials narrower than owner tokens and narrower than client grants.
- Preserve source-instance separation before records enter existing query/index paths.
- Make device batches idempotent and retry-safe.
- Give owners enough diagnostics to see whether a device exporter is healthy or stale.
- Keep SQLite and Postgres behavior equivalent.

**Non-Goals:**

- Do not define a PDPP Core source-instance field.
- Do not define a Collection Profile local-device exporter extension.
- Do not let clients request grants by device or source instance.
- Do not implement Claude Code until the Codex path proves the source-instance and queue design.
- Do not replace the existing server-owned connector runtime or scheduler.

## Decisions

### Reference-Only Route Family

Add device exporter routes under a reference-owned route family rather than `/v1` public client API routes.

- Owner-authenticated routes create enrollment codes, list devices/source instances, revoke devices, and read diagnostics.
- Device-authenticated routes exchange an enrollment code, heartbeat, and submit ingest batches.
- Device-authenticated routes use a dedicated device credential and MUST NOT accept owner bearer tokens or client grant tokens as substitutes.

This keeps the feature out of PDPP Core and avoids suggesting that device ingest is a standard client-facing protocol.

### Device And Source Instance Identity

The server assigns:

- `device_id`: stable enrolled device identity.
- `source_instance_id`: stable connector-on-device identity, initially derived from `{device_id, connector_id, local_binding_name}` but stored as an opaque server identity.

Pushed records are stored/indexed through source-instance-aware binding before they reach any current connector-shaped lookup. Public grant/query artifacts continue to expose `{ kind: "connector", id: connector_id }` unless a later accepted protocol/profile change says otherwise.

### Enrollment And Credential Scope

The owner creates a short-lived one-time enrollment code. A local agent exchanges that code for:

- `device_id`
- a device-scoped ingest token
- initial source instance metadata for the selected connector

The token is revocable and scoped to the enrolled device. It can heartbeat and ingest for that device only. It cannot read records, create grants, approve consent, issue owner tokens, or mutate other devices.

### Batch Ingest Contract

The device agent submits batches with:

- `device_id`
- `source_instance_id`
- `batch_id`
- `batch_seq`
- `body_hash`
- connector id
- stream
- record key
- emitted time
- normalized record data

The server stores batch outcomes by `(device_id, batch_id, body_hash)`. A retry with the same tuple returns the original outcome. Reusing the same `(device_id, batch_id)` with a different `body_hash` is rejected as a conflict.

### Local Queue And Retry

The agent keeps a small durable queue under the local PDPP/Codex exporter state directory. Failed batches remain queued with exponential backoff and per-source-instance ordering. Permanent validation errors are recorded locally and reported in the next heartbeat instead of being retried forever.

### Dashboard Diagnostics

The live owner dashboard shows:

- enrolled devices
- source instances per device
- connector id and local binding name
- last heartbeat
- last successful ingest
- accepted/rejected counts
- stale/unreachable state
- revoked state
- last error

Dashboard UI remains an owner/operator surface, not protocol documentation.

## Risks / Trade-offs

- [Risk] Source-instance identity later becomes a PDPP/Profile concept with a different shape. -> Mitigation: keep fields reference-only and link to the existing protocol open question before promoting anything public.
- [Risk] Device tokens become owner-token equivalents by accident. -> Mitigation: dedicated credential kind, narrow route authorization, tests proving read/owner/client routes reject device tokens.
- [Risk] Batch retries duplicate records or corrupt ordering. -> Mitigation: idempotency table plus per-source-instance queue ordering tests.
- [Risk] Postgres and SQLite drift. -> Mitigation: storage-adapter conformance tests for device enrollment, source instances, token lookup, batch idempotency, and diagnostics.
- [Risk] Dashboard freshness is misleading. -> Mitigation: derive stale state from server-observed heartbeat/ingest times and surface last error explicitly.

## Migration Plan

No production migration is required. Existing deployments start with zero enrolled devices. New tables are additive, and the feature is dormant unless an owner creates an enrollment code and runs the local exporter.

Rollback is disabling the local exporter route/agent and leaving inert device tables in place; existing grant/query behavior remains unchanged.

## Open Questions

- Protocol/Profile owner: whether `source_instance_id` should ever become Core, Collection Profile, or manifest-level contract surface.
- Protocol/Profile owner: whether clients should ever be able to request/query by device/source instance.
- RI owner: exact dashboard route placement and whether the first UI is a page under deployment diagnostics or its own device exporter page.
