## MODIFIED Requirements

### Requirement: Client event subscriptions are a discoverable RI extension and grant-scoped

The reference implementation SHALL expose outbound client event subscriptions at the canonical resource-server path `/v1/event-subscriptions`. It SHALL advertise the surface in the resource server's protected-resource metadata document under `capabilities.client_event_subscriptions`, with `supported: true`, `stability: "reference_extension"`, and `scope: "reference_implementation"`. The advertisement SHALL document the endpoint, supported event types, the signing profile and header names, delivery semantics (at-least-once, after-commit, retry schedule, max attempts), verification handshake, hint cursor field, callback-URL HTTPS requirement, and client-visible byte limits. The reference SHALL NOT widen client grants to enable subscriptions, and SHALL NOT accept owner bearer tokens or local device credentials as authorization for client subscription endpoints.

Subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record the bearer's `(grant_id, client_id, subject_id)` and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request to `POST /v1/event-subscriptions` with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once
- **AND** the secret SHALL carry the Standard Webhooks `whsec_` prefix

#### Scenario: A different client attempts to read another client's subscription
- **WHEN** a client bearer requests `GET /v1/event-subscriptions/:id` for a subscription whose stored `client_id` differs from the bearer's
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: An owner bearer attempts to use a client subscription endpoint
- **WHEN** an owner bearer token (not a client token) is presented to any `/v1/event-subscriptions[...]` endpoint
- **THEN** the reference SHALL reject the request with HTTP 403

#### Scenario: A client reads the protected-resource metadata
- **WHEN** a client reads `/.well-known/oauth-protected-resource` on the resource server
- **THEN** the response SHALL include `capabilities.client_event_subscriptions` with `supported: true`, `stability: "reference_extension"`, and an `endpoint` of `/v1/event-subscriptions`
- **AND** the advertisement SHALL declare the envelope as `format: "cloudevents+json"`, `specversion: "1.0"`, and `pdppversion: "1"`
- **AND** the advertisement SHALL declare the signing profile as `standard-webhooks` with `algorithm: "HMAC-SHA256"`, `id_header: "webhook-id"`, `timestamp_header: "webhook-timestamp"`, `signature_header: "webhook-signature"`, `signed_payload: "{webhook-id}.{webhook-timestamp}.{body}"`, `signature_encoding: "v1,<base64>"`, and `secret_prefix: "whsec_"`
- **AND** the advertisement SHALL include the set of supported event types (`pdpp.subscription.verify`, `pdpp.subscription.test`, `pdpp.records.changed`, `pdpp.grant.revoked`), the delivery semantics (at-least-once, after-commit, max-attempts), the verification handshake shape, and the hint cursor location

### Requirement: Events are projection-safe hints derived from grant scope

The reference SHALL derive client events from `record_changes` and grant scope using a pure derivation step. The derived envelope SHALL conform to CloudEvents 1.0 (`specversion: "1.0"`) and SHALL carry the PDPP profile version in the `pdppversion` CloudEvents extension attribute. The envelope SHALL NOT contain record bodies, field values, or resource identifiers outside the bound grant. It SHALL include the stream name only when that stream is in the subscription's scope snapshot, and a `changes_since` cursor that can be passed to the existing records-list endpoint to retrieve the notified change. The envelope's `source` SHALL be the canonical dereferenceable path of the subscription on the resource server (`/v1/event-subscriptions/<subscription_id>`).

#### Scenario: A record changes in a stream the grant covers
- **WHEN** `ingestRecord` commits a change for a stream that lies inside an active subscription's scope snapshot
- **THEN** the reference SHALL enqueue a `pdpp.records.changed` envelope referencing that stream
- **AND** the envelope SHALL set `specversion` to `"1.0"` and `pdppversion` to `"1"`
- **AND** the envelope's `data.changes_since` SHALL be an opaque cursor the client can pass to `rs.records.list` to retrieve the change
- **AND** the envelope's `source` SHALL be `/v1/event-subscriptions/<subscription_id>`

#### Scenario: A record changes in a stream the grant does not cover
- **WHEN** `ingestRecord` commits a change for a stream that lies outside every active subscription's scope snapshot
- **THEN** the reference SHALL NOT enqueue an event for any of those subscriptions

#### Scenario: An envelope is constructed
- **WHEN** the derivation step builds an envelope for any event type
- **THEN** the envelope SHALL NOT include record bodies, projected field values, or resource identifiers that are not already declared in the bound grant
- **AND** the envelope SHALL NOT use any value other than `"1.0"` for `specversion`

### Requirement: Event delivery is signed, after-commit, idempotent, and retried

The reference SHALL enqueue events only after the underlying durable mutation has committed and is readable through the existing read path. Each delivery request SHALL carry a Standard Webhooks signature constructed as `HMAC-SHA256(secret, "{webhook-id}.{webhook-timestamp}.{raw body}")` and emitted as `webhook-signature: v1,<base64>`, plus a stable `webhook-id` for receiver-side idempotency and a `webhook-timestamp` recording the unix-seconds value used in the signed string. Delivery SHALL be at-least-once with exponential backoff retry and a final dead-letter state.

#### Scenario: A record change commits
- **WHEN** `ingestRecord` returns `changed`
- **THEN** the reference SHALL enqueue any derived events only after the durable transaction has committed and the change is readable

#### Scenario: A delivery attempt is made
- **WHEN** the delivery worker posts an event to a subscription callback
- **THEN** the request SHALL include `webhook-id` (the stable event id), `webhook-timestamp` (the unix-seconds value used in the signed string), and `webhook-signature` (a `v1,<base64>` token computed as `HMAC-SHA256(secret_key, "{webhook-id}.{webhook-timestamp}.{raw body}")`)
- **AND** the request SHALL NOT include any `PDPP-Event-*` headers or any `PDPP-Subscription-Id` header
- **AND** the reference SHALL persist an attempt log row recording status code, latency, and a bounded response snippet

#### Scenario: A delivery attempt fails transiently
- **WHEN** a delivery attempt returns a non-2xx response or fails to connect
- **THEN** the reference SHALL reschedule the event for retry using the configured backoff schedule
- **AND** SHALL NOT advance the event past dead-letter until the configured maximum attempts are exhausted

#### Scenario: Delivery exhausts retries
- **WHEN** an event has exhausted the maximum delivery attempts
- **THEN** the reference SHALL mark the event `final_failure`
- **AND** SHALL transition the subscription to `disabled_failure`
- **AND** SHALL stop delivering further events for that subscription until it is re-enabled

#### Scenario: A receiver verifies a delivery with a stock Standard Webhooks library
- **WHEN** a receiver verifies the delivery using the secret returned at subscription create, the `webhook-id` and `webhook-timestamp` headers, and the raw request body
- **THEN** any conforming Standard Webhooks library SHALL accept the `webhook-signature` value without PDPP-specific code
- **AND** the subscription secret SHALL be a `whsec_`-prefixed string whose suffix base64-decodes to the HMAC key
