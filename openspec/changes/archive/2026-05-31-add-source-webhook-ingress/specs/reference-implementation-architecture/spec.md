## MODIFIED Requirements

### Requirement: Source webhook ingress is reference-only and source-authenticated

The reference implementation SHALL expose source webhook ingress only as reference-runtime behavior at `POST /_ref/source-webhooks/:sourceId` on the RS application only. It SHALL NOT register the ingress route on the AS application. It SHALL NOT advertise source webhooks as core PDPP support, SHALL NOT add event-driven grant semantics, and SHALL NOT accept source callbacks authenticated with owner bearer tokens, client grant tokens, or local collector device credentials.

The ingress route SHALL NOT appear in `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, or any other public PDPP metadata endpoint.

When no per-source HMAC secret is configured for a given `sourceId`, the reference SHALL return HTTP 404 with error code `unknown_source`. The endpoint is active only for source ids present in the operator-configured secret map (`PDPP_SOURCE_WEBHOOK_SECRETS`).

#### Scenario: A source callback reaches the reference ingress endpoint
- **WHEN** a caller posts a source webhook callback to `POST /_ref/source-webhooks/:sourceId`
- **THEN** the reference SHALL authenticate the callback with the per-source HMAC credential before processing the body
- **AND** the reference SHALL reject missing, malformed, stale, or invalid signatures before mutating records or scheduler state

#### Scenario: Metadata is requested
- **WHEN** a client reads public PDPP metadata from `/.well-known/oauth-protected-resource` or `/.well-known/oauth-authorization-server`
- **THEN** the reference SHALL NOT advertise the reference source webhook endpoint as a public PDPP capability

#### Scenario: Owner or client session credentials are presented
- **WHEN** a caller posts to `POST /_ref/source-webhooks/:sourceId` with a valid owner-session cookie, owner bearer token, or client grant bearer token
- **THEN** the reference SHALL NOT use those credentials to authenticate the webhook callback
- **AND** the reference SHALL authenticate only via the `PDPP-Webhook-Signature` header against the configured per-source HMAC secret

#### Scenario: The source is not configured
- **WHEN** the request identifies all required source-webhook headers
- **AND** no per-source HMAC secret is configured for the given `sourceId`
- **THEN** the reference SHALL return HTTP 404 with error code `unknown_source` before performing any signature or timestamp check

---

### Requirement: Source webhook ingress uses a PDPP-specific signed envelope

The reference implementation SHALL authenticate source webhook callbacks using three required request headers with a defined signing scheme.

Required headers:

| Header | Format | Purpose |
|---|---|---|
| `PDPP-Webhook-Timestamp` | Decimal integer string of Unix epoch seconds | Replay-protection timestamp |
| `PDPP-Webhook-Event-Id` | Non-empty opaque string | Idempotency key component |
| `PDPP-Webhook-Signature` | `sha256=<lowercase-hex>` | HMAC-SHA256 authenticity |

The signed material SHALL be `"${timestamp}.${body}"` where `timestamp` is the value of the `PDPP-Webhook-Timestamp` header and `body` is the raw UTF-8 request body. The expected signature SHALL be `sha256=` followed by the lowercase hex encoding of `HMAC-SHA256(secret, signed_material)` where `secret` is the per-source HMAC secret. Signature comparison SHALL use a timing-safe equality check.

HTTP header names are case-insensitive. The header names above are the
canonical documentation casing; adapters MAY receive or normalize them in
lowercase.

These header names are intentionally PDPP-prefixed rather than the Standard Webhooks v1 names (`webhook-id`, `webhook-timestamp`, `webhook-signature`). Standard Webhooks v1 is the right choice for the outbound client-event-subscription delivery direction (where the reference is the sender). Source webhook ingress is the receiver direction: the reference accepts callbacks from source platforms with their own signing schemes, and standardizing inbound header names would require every source platform to adopt PDPP header names. PDPP-prefixed names correctly signal that this is a reference-specific adapter contract, not a PDPP Core protocol surface.

#### Scenario: All required headers are present and signature matches
- **WHEN** a caller posts a request with valid `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, and `PDPP-Webhook-Signature` headers
- **AND** the signature matches `sha256=hex(HMAC-SHA256(secret, "${timestamp}.${body}"))` using the configured per-source secret
- **AND** the timestamp is within the accepted tolerance window
- **THEN** the reference SHALL proceed to idempotency checking and payload processing

#### Scenario: A required header is absent or blank
- **WHEN** any of `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, or `PDPP-Webhook-Signature` is absent or blank
- **THEN** the reference SHALL reject the request with HTTP 401 before processing the body
- **AND** the error code SHALL identify which header is missing (`missing_timestamp`, `missing_event_id`, or `missing_signature`)

#### Scenario: The signature does not match
- **WHEN** the `PDPP-Webhook-Signature` header is present but does not match the expected HMAC for the given body, timestamp, and per-source secret
- **THEN** the reference SHALL reject the request with HTTP 401 and error code `invalid_signature`

---

### Requirement: Source webhook ingress enforces a timestamp tolerance window

The reference implementation SHALL reject callbacks whose `PDPP-Webhook-Timestamp` value, when interpreted as Unix epoch seconds, differs from the server's current wall-clock time by more than 300 seconds (5 minutes). Timestamp rejection SHALL occur after required-header validation and per-source secret resolution, and before signature verification.

#### Scenario: The timestamp is within the tolerance window
- **WHEN** `abs(server_time_seconds - timestamp_seconds) <= 300`
- **THEN** the reference SHALL proceed to HMAC signature verification

#### Scenario: The timestamp is outside the tolerance window
- **WHEN** `abs(server_time_seconds - timestamp_seconds) > 300`
- **THEN** the reference SHALL reject the request with HTTP 401 and error code `stale_timestamp`
- **AND** the reference SHALL NOT perform HMAC signature verification or body parsing for that request

---

### Requirement: Source webhook ingress prevents replay before mutation

The reference implementation SHALL persist an idempotency decision for each accepted source webhook event before applying record mutations or scheduler signals. The idempotency key SHALL be the composite `(source_id, event_id)` where `event_id` is the value of the `PDPP-Webhook-Event-Id` header. The persistence layer SHALL enforce a `UNIQUE(source_id, event_id)` constraint so that concurrent or retried deliveries of the same event are serialized at the storage layer.

#### Scenario: A new event is received
- **WHEN** the `(sourceId, eventId)` pair has not been previously accepted
- **THEN** the reference SHALL insert an idempotency record before executing ingest or scheduler operations
- **AND** record mutations or scheduler signals SHALL execute only after the idempotency record is durably committed

#### Scenario: A duplicate source event is received
- **WHEN** a source webhook event with a previously accepted `(sourceId, eventId)` pair is received again
- **THEN** the reference SHALL return HTTP 202 with `{ "accepted": true, "duplicate": true, "source_id": "…", "event_id": "…" }`
- **AND** the reference SHALL NOT reapply record mutations or scheduler signals for that event

---

## ADDED Requirements

### Requirement: Source webhook ingress error codes and HTTP statuses are enumerated

The reference implementation SHALL return the following error codes and HTTP status codes for authentication, replay, and payload failures at the source webhook ingress endpoint:

| Error code | HTTP status | Trigger condition |
|---|---|---|
| `missing_event_id` | 401 | `PDPP-Webhook-Event-Id` header absent or blank |
| `missing_timestamp` | 401 | `PDPP-Webhook-Timestamp` header absent or blank |
| `missing_signature` | 401 | `PDPP-Webhook-Signature` header absent or blank |
| `unknown_source` | 404 | No HMAC secret configured for the given `sourceId` |
| `stale_timestamp` | 401 | Timestamp is outside the ±5-minute tolerance window |
| `invalid_signature` | 401 | HMAC-SHA256 mismatch |
| `invalid_payload` | 400 | Body is not a JSON object, `action` value is not recognized, or required fields for the stated `action` are missing |

All error responses SHALL use the reference's standard PDPP error envelope. Auth and replay failures SHALL return 401 rather than 403 to avoid revealing credential presence to unauthenticated callers. The `unknown_source` 404 is intentional: a wrong `sourceId` in the URL is a diagnosable operator misconfiguration, and source ids are not secret.

#### Scenario: An auth or replay failure is returned
- **WHEN** a webhook callback fails for any authentication or replay reason
- **THEN** the HTTP response SHALL use the error code and HTTP status from the table above
- **AND** the response body SHALL use the reference's standard PDPP error envelope

#### Scenario: A payload error is returned
- **WHEN** the callback passes authentication and replay checks but the body is malformed, unrecognized, or missing required fields
- **THEN** the reference SHALL return HTTP 400 with error code `invalid_payload`

---

### Requirement: Source webhook ingress supports two payload action values

The reference implementation SHALL accept source webhook payloads with one of two `action` values: `ingest_records` and `schedule_run`. Any other `action` value SHALL cause the reference to return HTTP 400 with error code `invalid_payload`.

**`action: "ingest_records"`** — push records into the reference's existing record-ingest path. Required additional fields:
- `stream` — non-empty string identifying the target stream declared in the connector manifest.
- `records` — array of record objects to ingest.

Records SHALL be serialized as NDJSON and passed to the existing record-ingest operation (`rs.records.ingest`). The webhook path SHALL NOT bypass stream lookup, record validation, tombstone behavior, versioning, indexing, or grant-visible query behavior.

**`action: "schedule_run"`** — request a connector refresh. No additional fields are required. The request SHALL be classified through the shared automation policy model with `trigger_kind: "webhook"`. The run SHALL be started only if the automation policy resolves `allowed_to_start: true`. If the runtime controller is unavailable, the reference SHALL fall back to signaling the scheduler's last-run-time record.

#### Scenario: A signed record-push callback is accepted
- **WHEN** an authenticated source callback carries `{ "action": "ingest_records", "stream": "<name>", "records": [ … ] }`
- **THEN** the reference SHALL process those records through the existing `rs.records.ingest` operation for the connector bound to that `sourceId`
- **AND** the response SHALL include `records_accepted` and `records_rejected` counts from that operation

#### Scenario: `ingest_records` is missing required fields
- **WHEN** an authenticated source callback carries `"action": "ingest_records"` but `stream` is absent or blank, or `records` is not an array
- **THEN** the reference SHALL return HTTP 400 with error code `invalid_payload`

#### Scenario: A signed run-trigger callback is accepted and automation policy permits the run
- **WHEN** an authenticated source callback carries `{ "action": "schedule_run" }` and the automation policy resolves `allowed_to_start: true`
- **THEN** the reference SHALL request a connector refresh with `trigger_kind: "webhook"` for the connector bound to that `sourceId`
- **AND** the webhook handler SHALL NOT start the connector run outside the shared automation policy model
- **AND** when the runtime controller is unavailable, the reference SHALL fall back to signaling the scheduler's last-run-time record instead of dropping the request

#### Scenario: Automation policy blocks the run
- **WHEN** an authenticated source callback carries `{ "action": "schedule_run" }` but the automation policy resolves `allowed_to_start: false`
- **THEN** the reference SHALL return HTTP 200 with `{ "action": "schedule_run", "run": null, "automation_policy": { … } }`
- **AND** the automation policy result SHALL be included in the response body for operator diagnostics
