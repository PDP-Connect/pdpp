## ADDED Requirements

### Requirement: Client event subscriptions are a discoverable RI extension and grant-scoped

The reference implementation SHALL expose outbound client event subscriptions at the canonical resource-server path `/v1/event-subscriptions`. It SHALL advertise the surface in the resource server's protected-resource metadata document under `capabilities.client_event_subscriptions`, with `supported: true`, `stability: "reference_extension"`, and `scope: "reference_implementation"`. The advertisement SHALL document the endpoint, supported event types, signing algorithm and header names, delivery semantics (at-least-once, after-commit, retry schedule, max attempts), verification handshake, hint cursor field, callback-URL HTTPS requirement, and client-visible byte limits. The reference SHALL NOT widen client grants to enable subscriptions, and SHALL NOT accept owner bearer tokens or local device credentials as authorization for client subscription endpoints.

Subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record the bearer's `(grant_id, client_id, subject_id)` and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request to `POST /v1/event-subscriptions` with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once

#### Scenario: A different client attempts to read another client's subscription
- **WHEN** a client bearer requests `GET /v1/event-subscriptions/:id` for a subscription whose stored `client_id` differs from the bearer's
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: An owner bearer attempts to use a client subscription endpoint
- **WHEN** an owner bearer token (not a client token) is presented to any `/v1/event-subscriptions[...]` endpoint
- **THEN** the reference SHALL reject the request with HTTP 403

#### Scenario: A client reads the protected-resource metadata
- **WHEN** a client reads `/.well-known/oauth-protected-resource` on the resource server
- **THEN** the response SHALL include `capabilities.client_event_subscriptions` with `supported: true`, `stability: "reference_extension"`, and an `endpoint` of `/v1/event-subscriptions`
- **AND** the advertisement SHALL include the signing algorithm `HMAC-SHA256`, the signature header `PDPP-Event-Signature`, the canonical signed-payload form `<timestamp>.<body>`, the set of supported event types (`pdpp.subscription.verify`, `pdpp.subscription.test`, `pdpp.records.changed`, `pdpp.grant.revoked`), the delivery semantics (at-least-once, after-commit, max-attempts), the verification handshake shape, and the hint cursor location

### Requirement: Subscription delivery is verified before any record-driven events ship

The reference SHALL deliver no record-driven events to a callback URL until the URL has completed a one-shot verification handshake. The handshake SHALL be signed with the subscription secret like all other events, and SHALL require the callback to echo a server-issued challenge.

#### Scenario: A new subscription is created
- **WHEN** a subscription is persisted in state `pending_verification`
- **THEN** the reference SHALL enqueue exactly one `subscription.verify` event carrying a server-issued challenge string
- **AND** record-driven events for that subscription SHALL be held until the handshake succeeds

#### Scenario: The callback echoes the challenge
- **WHEN** the verification callback returns HTTP 2xx with a body containing the same challenge string
- **THEN** the reference SHALL transition the subscription to `active`
- **AND** subsequent record-driven events for that subscription SHALL become eligible for delivery

#### Scenario: The callback fails the handshake
- **WHEN** the verification callback returns a non-2xx response or omits the challenge
- **THEN** the reference SHALL keep the subscription in `pending_verification`
- **AND** SHALL NOT enqueue or deliver further events for the subscription until the client explicitly retries verification

### Requirement: Events are projection-safe hints derived from grant scope

The reference SHALL derive client events from `record_changes` and grant scope using a pure derivation step. The derived envelope SHALL NOT contain record bodies, field values, or resource identifiers outside the bound grant. It SHALL include the stream name only when that stream is in the subscription's scope snapshot, and a `changes_since` cursor pointing at or after the change's `record_changes.version`. The envelope's `source` SHALL be the canonical dereferenceable path of the subscription on the resource server (`/v1/event-subscriptions/<subscription_id>`).

#### Scenario: A record changes in a stream the grant covers
- **WHEN** `ingestRecord` commits a change for a stream that lies inside an active subscription's scope snapshot
- **THEN** the reference SHALL enqueue a `pdpp.records.changed` envelope referencing that stream
- **AND** the envelope's `data.changes_since` SHALL be a cursor the client can pass to `rs.records.list` to retrieve the change
- **AND** the envelope's `source` SHALL be `/v1/event-subscriptions/<subscription_id>`

#### Scenario: A record changes in a stream the grant does not cover
- **WHEN** `ingestRecord` commits a change for a stream that lies outside every active subscription's scope snapshot
- **THEN** the reference SHALL NOT enqueue an event for any of those subscriptions

#### Scenario: An envelope is constructed
- **WHEN** the derivation step builds an envelope for any event type
- **THEN** the envelope SHALL NOT include record bodies, projected field values, or resource identifiers that are not already declared in the bound grant

### Requirement: Event delivery is signed, after-commit, idempotent, and retried

The reference SHALL enqueue events only after the underlying durable mutation has committed and is readable through the existing read path. Each delivery request SHALL carry an HMAC-SHA256 signature over `<timestamp>.<raw body>` using the per-subscription secret, plus a stable `PDPP-Event-Id` for receiver-side idempotency. Delivery SHALL be at-least-once with exponential backoff retry and a final dead-letter state.

#### Scenario: A record change commits
- **WHEN** `ingestRecord` returns `changed`
- **THEN** the reference SHALL enqueue any derived events only after the durable transaction has committed and the change is readable

#### Scenario: A delivery attempt is made
- **WHEN** the delivery worker posts an event to a subscription callback
- **THEN** the request SHALL include `PDPP-Event-Timestamp`, `PDPP-Event-Id`, `PDPP-Subscription-Id`, and `PDPP-Event-Signature: sha256=<hex>` over `<timestamp>.<raw body>` keyed by the subscription secret
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

### Requirement: Subscription state tracks grant lifecycle

The reference SHALL keep client subscription state coherent with the bound grant. Revocation or expiration of the grant SHALL disable the subscription, drop queued events, and emit at most one `pdpp.grant.revoked` hint if the subscription was previously active.

#### Scenario: A grant is revoked
- **WHEN** a grant bound to one or more subscriptions transitions to revoked
- **THEN** the reference SHALL emit at most one `pdpp.grant.revoked` event per subscription that was previously active
- **AND** SHALL transition those subscriptions to `disabled_revoked`
- **AND** SHALL drop any not-yet-delivered queued events for those subscriptions

### Requirement: Subscription storage parity across SQLite and Postgres backends

The reference SHALL persist subscription, queue, and attempt state with equivalent semantics on both reference storage backends (SQLite and Postgres). The active backend is selected by `isPostgresStorageBackend()`; the host-adapter store resolver SHALL pick the matching implementation, and worker-facing claim/attempt helpers SHALL run against that same backend.

#### Scenario: The reference boots against a Postgres backend
- **WHEN** the reference is configured for the Postgres storage backend
- **THEN** schema bootstrap SHALL create `client_event_subscriptions`, `client_event_queue`, and `client_event_attempts` with the columns, indexes, and check constraints documented in the design
- **AND** the default subscription store SHALL execute writes and reads via the Postgres-backed implementation
- **AND** the delivery worker's queue claim and attempt-log helpers SHALL run against the same Postgres database

#### Scenario: The reference boots against an SQLite backend
- **WHEN** the reference is configured for the SQLite storage backend
- **THEN** the default subscription store SHALL execute via the registered SQL artifacts under `server/queries/client-event-subscriptions/`
- **AND** the operation, worker, and route layers SHALL not require any code changes to swap backends

#### Scenario: A subscription is created, verified, and revoked on Postgres
- **WHEN** the lifecycle (`create → verify → list → rotate secret → enqueue test event → claim queue → log attempt → grant revoke`) runs against a Postgres-backed reference
- **THEN** every step SHALL succeed against the live Postgres backend
- **AND** the queue claim path SHALL return the subscription's callback URL, secret, and current status joined to each queued row, exactly as the SQLite path does
