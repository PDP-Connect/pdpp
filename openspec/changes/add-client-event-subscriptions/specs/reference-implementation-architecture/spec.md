## ADDED Requirements

### Requirement: Client event subscriptions are reference-only and grant-scoped

The reference implementation SHALL expose outbound client event subscriptions only as reference-runtime behavior. It SHALL NOT advertise client event subscriptions as core PDPP support, SHALL NOT widen client grants to enable subscriptions, and SHALL NOT accept owner bearer tokens or local device credentials as authorization for client subscription endpoints.

Subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record the bearer's `(grant_id, client_id, subject_id)` and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once

#### Scenario: A different client attempts to read another client's subscription
- **WHEN** a client bearer requests `GET /_ref/client-event-subscriptions/:id` for a subscription whose stored `client_id` differs from the bearer's
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: Metadata is requested
- **WHEN** a client reads public PDPP protected-resource metadata
- **THEN** the reference SHALL NOT advertise the client event subscription endpoints as a public PDPP capability

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

The reference SHALL derive client events from `record_changes` and grant scope using a pure derivation step. The derived envelope SHALL NOT contain record bodies, field values, or resource identifiers outside the bound grant. It SHALL include the stream name only when that stream is in the subscription's scope snapshot, and a `changes_since` cursor pointing at or after the change's `record_changes.version`.

#### Scenario: A record changes in a stream the grant covers
- **WHEN** `ingestRecord` commits a change for a stream that lies inside an active subscription's scope snapshot
- **THEN** the reference SHALL enqueue a `pdpp.records.changed` envelope referencing that stream
- **AND** the envelope's `data.changes_since` SHALL be a cursor the client can pass to `rs.records.list` to retrieve the change

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
