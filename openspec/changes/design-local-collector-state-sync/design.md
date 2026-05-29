# Design

## Context

Reference review of the Gmail attachment backfill branch surfaced three real gaps in the local collector lane:

1. `packages/polyfill-connectors/src/collector-runner.ts` filters emitted messages with `messages.filter((msg) => msg.type === "RECORD")` and discards `STATE`.
2. `buildCollectorStartMessage(streams, streamsToBackfill)` builds `START` without populating the existing `state?: Record<string, unknown>` field on `StartMessage`.
3. `packages/polyfill-connectors/src/local-device-client.ts` exposes only `exchangeEnrollment`, `heartbeat`, and `ingestBatch`. There is no device-authenticated state load or state put endpoint.

The owner-authenticated state contract at `GET|PUT /v1/state/:connectorId` (see `reference-implementation/server/index.js`, mounted with `requireToken` + `requireOwner`) is keyed by `(connectorId, grantId)` and is intentionally off-limits to device credentials. The local device exporter runbook is explicit:

> Device credentials are not owner or client grant tokens. Owner-token and client-token routes do not accept device credentials.

So the design has to choose: weaken the boundary, or extend the device-exporter authority family with a state surface that is structurally analogous to the existing device ingest/heartbeat routes.

We pick option two. This is the same shape the device-exporter family already uses for records and diagnostics; the only new behavior is reading and writing a small JSON state map, scoped by `(deviceId, sourceInstanceId)` rather than `(connectorId, grantId)`.

## Goals

- A local connector that needs a cursor can resume after restart, retry, or device replacement.
- The collector runner is the single component that owns state load/replay/persist for a connector child; the connector itself sees the existing `START.state` and emits `STATE` exactly as in-process runtime connectors do today.
- No new authority is introduced. Existing device-exporter bearer credential is sufficient.
- No new public PDPP surface. All new routes are `_ref/*` and explicitly reference-only.
- Source-instance isolation mirrors what `device ingest` already does for records.
- Crash semantics are honest: state never advances past records the server has acknowledged.

## Non-Goals

- Promoting `source_instance_id` or device identity into Collection Profile vocabulary. That open question is preserved.
- Changing `GET|PUT /v1/state/:connectorId` semantics or replacing it.
- Cross-device state convergence. Each `(deviceId, sourceInstanceId)` keeps its own state; reconciliation across instances is out of scope and is already framed as a Collection Profile / source-authority question (`design-notes/source-authority-vs-schema-identity-2026-04-30.md`).
- A connector-level "state schema" registry. State stays opaque JSON, as today.

## Decisions

### State Authority Lives On The Device-Exporter Family

Add two endpoints to the device-exporter route family:

- `GET  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`
- `PUT  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`

Both routes use `requireDeviceExporterCredential` (the same middleware as `heartbeat` and `ingest-batches`). The path `deviceId` must match `req.deviceExporter.deviceId`. The path `sourceInstanceId` must resolve via `deviceExporterStore.getSourceInstance(deviceId, sourceInstanceId)` and SHALL be rejected if unknown.

Rationale: this is the boundary that already exists in code and in the spec. Owner credentials never reach the device. Mode B collectors get a state surface that has the same trust shape as their existing ingest surface.

### State Storage Reuses `connector-state-store`

The server already has `reference-implementation/server/stores/connector-state-store.ts` keyed by `(connectorId, grantId)`. Reuse it. For device-exporter state, the storage call uses:

- `connectorId = referenceLocalDeviceStorageConnectorId(connectorId, sourceInstanceId)` — the exact internal-storage connector id already used for device ingest (`reference-implementation/server/index.js` device ingest route).
- `grantId = null`.

This means device state never collides with the owner-auth `/v1/state/:connectorId` path (which uses the public connector id and a non-null grant id when scoped). It also matches the existing isolation invariant ("Two devices push the same connector record key" — different storage connector ids, different state rows).

### `START.state` Is Populated From Prior State Before Spawn

Before `spawnConnector`, the collector runner SHALL:

1. Issue `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` with its device credential.
2. Pass the returned `state` map into `buildCollectorStartMessage(streams, streamsToBackfill, priorState)`.
3. Tolerate a `404 not_found` or empty `{}` body and treat it as "no prior state" — first run.

`buildCollectorStartMessage` SHALL set `start.state` only when prior state is non-empty so the `START` envelope stays minimal when there is nothing to replay.

The connector child SHALL receive prior state through the existing `StartMessage.state` field. No new env var is added to the child, since the runner is the only state authority and the child already gets state via the wire.

### Emitted `STATE` Is Buffered Per Stream, Flushed After Records Are Acknowledged

The runner SHALL accumulate emitted `STATE` messages as `{ [stream]: cursor }`, overwriting any earlier cursor for the same stream (last-wins per-stream, matching how `connector-state-store` projects state).

After `drainCollectorQueue` returns and the queue is empty of unsent batches, the runner SHALL `PUT` the accumulated state map. If the queue still has retrying items, the runner SHALL NOT advance state — it returns at end-of-pass with the last durably-flushed state intact. This is the "honest crash" property: state never moves past records the server has acknowledged.

This implies `drainCollectorQueue` continues to be the durability boundary for both records and state.

### `PUT` Is A Last-Write-Wins Merge, Not An Atomic Replace

The `PUT` handler SHALL accept `{ state: { [stream]: cursor } }` and call `connectorStateStore.putState({ connectorId: derived, grantId: null }, stateMap)`. The store's existing semantics are stream-scoped merge with `updated_at` bump; that is sufficient.

The runner sends one `PUT` per pass (covering every stream that emitted at least one `STATE` during that pass). The runner SHALL NOT issue partial mid-pass `PUT`s — a single end-of-pass flush keeps ordering and retry semantics simple.

### Retry And Restart Semantics

- If `PUT` state fails after records are durably accepted, the runner SHALL mark a recoverable warning (heartbeat `status: "retrying"` with `last_error.kind: "state_put_failed"`) and retry on the next pass.
- On restart, the runner re-reads state from the server, so a failed `PUT` followed by a process restart simply re-emits records that the connector child already considered consumed. Connectors are already expected to be idempotent at the record key level, and device ingest is idempotent at `(device_id, batch_id, body_hash)` — so re-running a pass is safe.
- If `GET` state fails at startup, the runner SHALL fail fast with a heartbeat `status: "blocked"` and exit non-zero. Without prior state, advancing would over-collect (e.g. re-emit historical Gmail attachments). Failing fast forces the operator surface to expose the problem.

### Source-Instance Isolation

State is keyed by source instance, not by device alone, because a single device may host multiple source homes (multi-binding Codex/Claude — see `complete-local-agent-collectors`). This matches device ingest semantics and avoids the "Two devices push the same connector record key" collision the device-exporter design already guards against.

### Secret Leakage

State payloads can carry OAuth refresh hints, message-id high water marks, or other sensitive cursors. Decisions:

- The state map is transmitted over the existing device-exporter HTTPS surface, authorized by the same bearer credential that already protects record ingest. No new exposure.
- The runner SHALL NOT log state payloads at any default log level. Existing collector heartbeat already avoids logging cursor contents; this design keeps that posture.
- The connector child receives prior state on stdin via `START.state`. It is already trusted with whatever secrets the connector accepts (OAuth tokens, etc.), and state is a strict subset of the trust the child already has.
- Owner credentials are NOT added to the collector child environment. The runner uses its device-scoped credential to fetch state and to write it. The child sees only the resulting `START.state` JSON.

### Effect On Existing Open Questions

- "Cross-stream checkpoint flush semantics" (existing open question in `reference-implementation-architecture`) is intentionally not closed here. The local collector lane uses the same per-stream last-wins projection as the in-process runtime, which is consistent with current ambiguity.
- "Public/source-instance vocabulary" is preserved as a Collection Profile question.

## Alternatives Considered

### Reuse `/v1/state/:connectorId` From The Device

Rejected. Requires either shipping an owner token to the device, weakening the explicit boundary the device-exporter authority was built around, or minting a special owner-impersonation grant. The runbook explicitly states owner-token routes do not accept device credentials. Breaking that for state would unbalance the authority model.

### Add State To The Existing Heartbeat Body

Rejected. Heartbeat is high-frequency and untracked; state needs an HTTP-level result and a durable write boundary. Mixing them would either bloat heartbeat or make state writes silently flaky. Splitting state into its own route also lets the dashboard surface state read/write activity independently in future without touching the heartbeat contract.

### Add State To Each Ingest Batch Body

Rejected. State and records have different ordering properties: state must follow record durability, never precede it. Putting state in the ingest body would force "state advances iff this batch is accepted," which is fine for one batch but loses meaning when a pass produces many batches. The single end-of-pass `PUT` is a clearer durability contract.

### Have The Connector Child Talk To The Server Directly For State

Rejected. The runner is already the single authority that holds the device credential. Letting the child make HTTP calls for state would force the child to either accept the device token (broader trust than connectors need) or open a new IPC channel back to the runner. The current child contract (stdin `START`, stdout `RECORD|STATE|DONE`) is sufficient.

### Persist State To A Local File On Device, Sync Lazily

Rejected as a primary mechanism. Local files create divergence between the durable record store on the server and the cursor the device thinks it's at. A device replacement or wipe would lose the cursor and over-collect. We may still keep a local cache in front of the GET later, but only as an optimization; the server is authoritative.

## Risks And Mitigations

- **Risk:** Connector emits `STATE` for an unscoped stream that was not in `START.scope.streams`.
  **Mitigation:** The collector runner SHALL drop `STATE` for streams not in scope and SHALL log a runtime warning. This matches the in-process runtime's strictness on stream membership.

- **Risk:** A device with stale credentials makes the runner exit before state is fetched, blocking forever.
  **Mitigation:** The 401/403 path from `GET state` is treated as a terminal credential error, the same way `ingestBatch` already treats it; the runner exits with a `blocked` heartbeat.

- **Risk:** `connector-state-store` rows under `referenceLocalDeviceStorageConnectorId(...)` become invisible to operators because the owner-auth state route filters on public connector id.
  **Mitigation:** Surface device state under existing `_ref/device-exporters` diagnostics so operators can see the cursor. This is a tasks.md item, not a spec requirement.

- **Risk:** Two collector processes for the same `(deviceId, sourceInstanceId)` race on `PUT state`.
  **Mitigation:** Profile lock on the device side (existing `profile-lock.ts`) prevents concurrent runs of the same connector. Server-side, `putState` is already last-write-wins; concurrent writes degrade gracefully into "one of the two cursors wins," which is acceptable because both came from valid record-acknowledged passes.

## Acceptance Checks

- `openspec validate design-local-collector-state-sync --strict` succeeds.
- A unit test for the collector runner shows: prior state is fetched, `START.state` is populated, emitted `STATE` messages are buffered, the end-of-pass `PUT` is issued only after `drainCollectorQueue` reports zero unsent items, and `STATE` for an out-of-scope stream is dropped with a warning.
- A reference-implementation route test confirms `GET|PUT _ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` accepts a valid device bearer token, rejects an owner-session-only request, rejects a credential for a different device, and rejects an unknown source instance.
- Gmail attachment backfill restart test (offline fixture, no live Gmail) shows the `attachments` stream cursor survives a runner restart when run via the local collector lane.

## Residual Risks

**Manual device-side state replay verification (pre-broad-rollout):** The automated two-pass replay regression (task 7.7) covers the full load/emit/persist/replay cycle using a fixture connector and is the authoritative correctness check. A manual end-to-end run on a real enrolled device — spawning the collector, observing the emitted STATE written to the server, restarting the runner, and confirming the cursor appears in the second pass's `START.state` — is recommended before broad rollout to catch any device-credential, network, or environment misconfiguration that fixture tests cannot exercise. This is a confidence check, not a correctness prerequisite.

## ADDED Requirements

### Requirement: Local collector runs replay prior connector state through START

The reference implementation SHALL load any prior persisted state for a local collector run before spawning the connector child, and SHALL pass it through the existing `StartMessage.state` field. State load SHALL use the device-scoped credential, scoped by `(deviceId, sourceInstanceId)`.

#### Scenario: A local collector starts with prior state

- **WHEN** the local collector runner spawns a connector child for a device-scoped source instance that has previously persisted state
- **THEN** the runner SHALL fetch that state with its device-scoped credential
- **AND** it SHALL set `StartMessage.state` to the fetched state map before writing `START` to the child
- **AND** the child SHALL NOT need to read state from any other surface

#### Scenario: A local collector starts with no prior state

- **WHEN** the local collector runner spawns a connector child for a source instance with no persisted state
- **THEN** the server SHALL respond to the state read with an empty map
- **AND** the runner SHALL omit `state` from the `START` message
- **AND** the child SHALL behave as if this is a first run

#### Scenario: State read fails

- **WHEN** the local collector runner cannot read prior state because of a network, credential, or server error
- **THEN** the runner SHALL NOT spawn the connector child
- **AND** it SHALL emit a heartbeat with `status: "blocked"` indicating a state-read failure
- **AND** it SHALL exit non-zero

### Requirement: Local collectors persist emitted STATE after records are durably accepted

The reference implementation SHALL persist emitted `STATE` messages from a local collector child only after the records that justify that state are durably accepted by the server.

#### Scenario: All record batches are accepted in a pass

- **WHEN** a local collector child emits `RECORD` messages and one or more `STATE` messages, and all enqueued record batches drain successfully via the existing device ingest path
- **THEN** the collector runner SHALL flush the accumulated `STATE` map to the device-scoped state endpoint once
- **AND** the persisted state SHALL be the per-stream last-wins projection of the emitted `STATE` messages during that pass

#### Scenario: Some record batches fail to drain in a pass

- **WHEN** a local collector child emits `RECORD` and `STATE` messages but the queue still contains unsent record batches at end-of-pass
- **THEN** the runner SHALL NOT advance persisted state for any stream in that pass
- **AND** the previously persisted state SHALL remain authoritative

#### Scenario: A STATE write fails after records were accepted

- **WHEN** record batches drain successfully but the state `PUT` fails
- **THEN** the runner SHALL surface that failure in its heartbeat
- **AND** the next run SHALL re-emit records that the previous pass already considered consumed
- **AND** ingest idempotency SHALL absorb the duplicates without doubling records in storage

#### Scenario: STATE arrives for an out-of-scope stream

- **WHEN** a local collector child emits `STATE` for a stream that was not in `START.scope.streams`
- **THEN** the runner SHALL drop that `STATE` message
- **AND** it SHALL emit a runtime warning identifying the offending stream

### Requirement: Local collector state is device-scoped, source-instance-isolated, and reference-only

The reference implementation SHALL expose local collector state read and write through the device-exporter authority, scoped by `(deviceId, sourceInstanceId)`. Owner-token and client-token routes SHALL NOT accept device credentials, and the device-scoped state route SHALL NOT accept owner or client credentials.

#### Scenario: A device reads or writes its own source-instance state

- **WHEN** a local collector presents a valid device-scoped credential to `GET|PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`, with a path `deviceId` matching the credential and a registered `sourceInstanceId`
- **THEN** the reference implementation SHALL serve or persist the state map keyed under the same internal storage connector id used for device record ingest for that source instance
- **AND** that state SHALL NOT collide with state persisted under the public connector id for owner-authenticated runs of the same connector

#### Scenario: Cross-device or cross-credential request

- **WHEN** a caller presents a device-scoped credential to a state route for a different device's id, an unknown source instance, or presents an owner or client bearer token to the device-scoped state route
- **THEN** the reference implementation SHALL reject the request without revealing state

#### Scenario: Owner-authenticated state route is unaffected

- **WHEN** an owner or client interacts with the existing `GET|PUT /v1/state/:connectorId` route
- **THEN** that route SHALL continue to operate keyed by `(connectorId, grantId)` with owner authentication
- **AND** it SHALL NOT serve or accept device-scoped state rows
