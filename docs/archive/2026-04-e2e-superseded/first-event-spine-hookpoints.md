# First Event Spine Hookpoints

Date: 2026-04-16

## Purpose

This memo answers one narrow question for the current `e2e/` stack:

- what is the smallest durable event table worth adding now
- which first protocol/runtime moments should be emitted now
- exactly where should those hooks attach in the existing code

This is intentionally narrower than the broader event-spine drafts. It is the first implementation cutline, not the final event model.

## 1. Recommended minimal durable event table fields

Use one append-only `spine_events` table first. Keep artifacts out of scope for the first pass unless a payload is too large or too sensitive to summarize inline.

Recommended fields:

| Field | Why it belongs in the first pass |
|---|---|
| `event_id` | Stable durable identity for inspection, replay, and test assertions |
| `occurred_at` | Time the underlying fact happened |
| `recorded_at` | Time the event row was persisted |
| `trace_id` | Groups one scenario or lifecycle slice without needing a full span tree yet |
| `scenario_id` nullable | Future-proofing for replay/illustrated-flow alignment; can be null at first |
| `event_type` | Typed event vocabulary |
| `status` | Small controlled set: `started`, `succeeded`, `failed`, `denied`, `expired`, `partial` |
| `object_type` | Dominant object or lifecycle seam, e.g. `pending_consent`, `grant`, `token`, `run`, `query` |
| `object_id` | The stable identifier for that object |
| `caused_by_event_id` nullable | Enough causal linkage for first-pass timelines without full spans |
| `grant_id` nullable | First-class PDPP object reference |
| `run_id` nullable | First-class Collection Profile object reference |
| `token_id` nullable | Needed for issuance/introspection/rejection history |
| `client_id` nullable | Needed for request, grant, token, and owner-device flow visibility |
| `subject_id` nullable | Needed for owner/grant lifecycle history |
| `connector_id` nullable | Still required for current polyfill/runtime seams |
| `stream` nullable | Needed for disclosure, ingest batch, and state advancement history |
| `request_id` nullable | Reuse existing HTTP request id when available; null for non-HTTP/runtime events |
| `data_json` | Small structured summary payload only |

Minimal design notes:

- Do **not** require `span_id` / `parent_span_id` in the first pass. `trace_id` plus `caused_by_event_id` is enough.
- Do **not** put full grants, full manifests, raw records, or raw tokens in the row. Summaries only.
- For the current grant-request seam, use `object_type = pending_consent` and `object_id = device_code` rather than inventing a separate `requests` table first.
- For the current query seam, use `object_type = query` and generate one opaque `query_id` at the route layer if needed. If that feels too heavy for pass one, use the `Request-Id` header value as `object_id`.

## 2. Recommended first event types

Start with **10** event types. This is enough to cover the current golden path across auth, disclosure, and runtime without turning the first pass into a second architecture project.

1. `request.submitted`
2. `consent.approved`
3. `grant.issued`
4. `token.issued`
5. `query.received`
6. `disclosure.served`
7. `run.started`
8. `run.batch_ingested`
9. `run.state_advanced`
10. `run.completed`

Why this set:

- It covers the current real seams already present in `auth.js`, `server/index.js`, and `runtime/index.js`.
- It proves the system end to end:
  - request / consent / grant
  - token creation
  - query + disclosure
  - collection run + ingest + checkpoint + completion
- It avoids premature bloat such as service lifecycle events, console-only events, or per-record event spam.

Deliberately deferred from the first pass:

- `consent.denied`
- `consent.expired`
- `grant.revoked`
- `token.introspected`
- `query.rejected`
- `run.interaction_required`
- `run.failed`

Those are real and worth adding soon, but they are not required to make the first golden-path trace credible.

## 3. Exact file / function hook points

### Auth / AS hooks

#### `request.submitted`

- File: `e2e/server/auth.js`
- Function: `initiateGrant(input, opts = {})`
- Exact hook: **after** `createPendingConsent(...)` succeeds and **before** returning the device/user code payload
- Object shape:
  - `object_type = pending_consent`
  - `object_id = deviceCode`
  - `client_id = normalized.client.client_id`
  - `connector_id = normalized.realization_binding.connector_id`
  - `status = succeeded`

Reason: this is the first durable request-side state transition in the current stack.

#### `consent.approved`

- File: `e2e/server/auth.js`
- Function: `approveGrant(deviceCode, subjectId, opts = {})`
- Exact hook: **after** `markPendingConsentApproved(...)` succeeds
- Object shape:
  - `object_type = pending_consent`
  - `object_id = deviceCode`
  - `grant_id = grantId`
  - `subject_id = subjectId`
  - `status = succeeded`

Reason: approval should be emitted only once the pending-consent row has durably transitioned.

#### `grant.issued`

- File: `e2e/server/auth.js`
- Function: `approveGrant(deviceCode, subjectId, opts = {})`
- Exact hook: **after** the `INSERT INTO grants(...)` succeeds and **before** token issuance
- Object shape:
  - `object_type = grant`
  - `object_id = grantId`
  - `grant_id = grantId`
  - `client_id`, `subject_id`, `connector_id`
  - `status = succeeded`

Reason: keep grant issuance distinct from token issuance.

#### `token.issued`

- File: `e2e/server/auth.js`
- Function: `issueToken(grantId, subjectId, clientId, expiresAt)`
- Exact hook: **after** `INSERT INTO tokens(...)` succeeds and **before** returning `tokenId`
- Object shape:
  - `object_type = token`
  - `object_id = tokenId`
  - `token_id = tokenId`
  - `grant_id = grantId`
  - `client_id`, `subject_id`
  - `status = succeeded`
  - `data_json.token_kind = client`

Also add the same `token.issued` type here:

- File: `e2e/server/auth.js`
- Function: `issueOwnerTokenRecord(subjectId)`
- Exact hook: **after** owner token insert succeeds
- Same shape, but `data_json.token_kind = owner`

Reason: one event type, differentiated by `token_kind`.

### RS / disclosure hooks

#### `query.received`

- File: `e2e/server/index.js`
- Route handler: `GET /v1/streams/:stream/records`
- Exact hook: **immediately before** `await queryRecords(...)`
- Object shape:
  - `object_type = query`
  - `object_id = req.get('Request-Id')` or generated query id
  - `grant_id` when client token
  - `connector_id`
  - `stream = req.params.stream`
  - `request_id = res.getHeader('Request-Id')`
  - `status = started`

Optional second hook later:

- File: `e2e/server/index.js`
- Route handler: `GET /v1/streams/:stream/records/:id`
- Same pattern for single-record reads

Reason: the event should attach at the route boundary, not inside `records.js`.

#### `disclosure.served`

- File: `e2e/server/index.js`
- Route handler: `GET /v1/streams/:stream/records`
- Exact hook: **after** `const result = await queryRecords(...)` succeeds and **before** `res.json(...)`
- Object shape:
  - `object_type = query`
  - `object_id = same query id as query.received`
  - `grant_id`, `connector_id`, `stream`
  - `status = succeeded`
  - `data_json.record_count = result.data.length`
  - `data_json.has_more = result.has_more`
  - `data_json.has_next_changes_since = !!result.next_changes_since`

Optional second hook later:

- File: `e2e/server/index.js`
- Route handler: `GET /v1/streams/:stream/records/:id`
- Emit the same type with `data_json.record_count = 1`

Reason: this is the first useful disclosure milestone without instrumenting field-by-field projection internals.

### Runtime hooks

#### `run.started`

- File: `e2e/runtime/index.js`
- Function: `runConnector(opts)`
- Exact hook: **immediately after** `proc.stdin.write(JSON.stringify(startMsg) + '\n')`
- Object shape:
  - `object_type = run`
  - `object_id = startMsg.run_id`
  - `run_id = startMsg.run_id`
  - `connector_id`, `grant_id`, `status = started`
  - `data_json.collection_mode = collectionMode`

Reason: the run id is created here; this is the natural root event for runtime history.

#### `run.batch_ingested`

- File: `e2e/runtime/index.js`
- Function: `flushBatch(stream)`
- Exact hook: **after** the ingest `fetch(...)` succeeds and the JSON response is parsed
- Object shape:
  - `object_type = run`
  - `object_id = startMsg.run_id` or captured `runId`
  - `run_id`, `connector_id`, `grant_id`, `stream`
  - `status = succeeded`
  - `data_json.batch_size = batch.length`
  - `data_json.records_accepted = result.records_accepted`
  - `data_json.records_rejected = result.records_rejected`

Reason: this proves data movement without emitting one event per record.

#### `run.state_advanced`

- File: `e2e/runtime/index.js`
- Function: `commitState(stream, cursor)`
- Exact hook: **after** the `PUT /v1/state/:connectorId` succeeds
- Object shape:
  - `object_type = run`
  - `object_id = runId`
  - `run_id`, `connector_id`, `grant_id`, `stream`
  - `status = succeeded`
  - `data_json.cursor_summary = <small summary or hash>`

Reason: checkpointing is the durable proof that incremental collection advanced.

#### `run.completed`

- File: `e2e/runtime/index.js`
- Function: `handleMsg(msg)` inside `runConnector()`
- Exact hook: in the `case 'DONE'` branch, **after** `flushAll()` and `commitState(...)` complete successfully and **before** `onProgress({ type: 'done', ... })`
- Object shape:
  - `object_type = run`
  - `object_id = runId`
  - `run_id`, `connector_id`, `grant_id`
  - `status = msg.status`
  - `data_json.records_emitted = msg.records_emitted`

Reason: this captures the run-level outcome only after the downstream side effects have actually landed.

## 4. Anti-scope warnings

1. **Do not make the event spine the new source of truth.**
   - Current tables for grants, tokens, records, and sync state remain authoritative.
   - The first spine is a durable derived history.

2. **Do not emit one event per record row from `e2e/server/records.js`.**
   - The right first runtime data event is `run.batch_ingested`, not `record.ingested`.
   - `record_changes` already holds record-level history.

3. **Do not start with spans, waterfalls, or OpenTelemetry adapters.**
   - `trace_id` + `caused_by_event_id` is enough for pass one.
   - Add `span_id` later only if a real consumer needs it.

4. **Do not emit console-only or landing-page-only events.**
   - Every event must correspond to a real protocol/runtime state transition already present in server/runtime code.

5. **Do not store secrets or large payloads in the event row.**
   - No bearer tokens, OTPs, cookies, full grants, full manifests, or raw records.
   - Use counts, ids, booleans, and small summaries only.

6. **Do not start by instrumenting `e2e/runtime/scheduler.js`.**
   - Its in-memory history is experimental and not yet canonical.
   - First instrument the direct golden path in `auth.js`, `server/index.js`, and `runtime/index.js`.

7. **Do not broaden the first pass into provider metadata, service lifecycle, or admin resets.**
   - Those are useful later, but they are not needed to prove the first reference trace.

## Recommendation

If only one golden-path scenario is instrumented first, the cleanest path is:

1. `request.submitted`
2. `consent.approved`
3. `grant.issued`
4. `token.issued`
5. `query.received`
6. `disclosure.served`
7. `run.started`
8. `run.batch_ingested`
9. `run.state_advanced`
10. `run.completed`

Emit those from the hook points above, keep the row small, and defer everything else until there is a real CLI/test/console consumer demanding it.
