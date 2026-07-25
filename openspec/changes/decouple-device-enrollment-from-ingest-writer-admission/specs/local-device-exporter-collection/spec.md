## ADDED Requirements

### Requirement: Device enrollment SHALL NOT contend on the ingest writer-admission gate

Device-exporter enrollment is a control-plane operation that mints device
credentials. It SHALL NOT be gated by, blocked on, or rejected because of the
connector-instance ingest writer-admission queue or its per-instance advisory
lock. Ensuring the connector catalog entry at enroll time SHALL persist the
catalog row without running retrieval-index (lexical/semantic) backfill inline.

#### Scenario: Bulk ingest saturates the writer-admission gate during an enroll

- **WHEN** unrelated bulk record ingest holds the connector-instance
  writer-admission gate and advisory lock, and a device attempts to enroll for
  that connector
- **THEN** the enroll SHALL complete without waiting on the ingest writer-admission
  gate or advisory lock
- **AND** the enroll SHALL return a device credential rather than hanging on lock
  acquisition or failing with a writer-admission error.

#### Scenario: A second device enrolls for a connector type that already has other, actively-ingesting instances

- **WHEN** at least one OTHER connector instance already holds records under the
  same connector_id (e.g. a prior device enrolled for the same connector type,
  or an account-bound instance of that connector type), that other instance's
  writer-admission gate is held by unrelated ingest, and a new device attempts to
  enroll for that connector
- **THEN** the enroll SHALL complete without entering the writer-admission gate
  for ANY connector instance — including instances other than the one being
  created
- **AND** manifest re-registration performed at enroll time SHALL NOT enumerate
  or repair derived per-record columns (cursor/primary-key/semantic-time) for
  other instances of the same connector_id, since enroll registers the static,
  unchanged local-collector manifest and has no derived-column drift to repair.

### Requirement: Enrollment SHALL be idempotent so a transport failure does not strand the one-time credential

Because the server cannot know whether a committed enroll response reached the
client, a device SHALL be able to retry enrollment with the same enrollment code
and obtain a usable credential, without duplicating device or source-instance
identity. The retry SHALL be accepted only for the same unexpired enrollment code
already bound to the same device and binding.

#### Scenario: A device retries enrollment after the response is lost in transit

- **WHEN** a device re-submits an enrollment code that was already consumed by the
  same device and binding, and the code has not expired
- **THEN** the reference SHALL rotate the device credential — revoking the prior
  credential and issuing exactly one fresh credential — and return the fresh
  credential
- **AND** the reference SHALL NOT create a second device or a second source
  instance
- **AND** any previously issued credential for that device SHALL be invalidated so
  only one current credential remains
- **AND** the reference SHALL emit an audit receipt recording the credential
  rotation.

#### Scenario: A consumed enrollment code is replayed after it expired

- **WHEN** a device re-submits a consumed enrollment code whose expiry has passed
- **THEN** the reference SHALL reject the request as expired
- **AND** SHALL NOT issue or rotate any credential.

#### Scenario: A consumed enrollment code is replayed for a different binding or device

- **WHEN** an enrollment code that was consumed by one device/binding is replayed
  in a way that does not resolve to that same device and binding
- **THEN** the reference SHALL reject the request
- **AND** SHALL NOT issue a credential for a different device or binding.

### Requirement: Enrollment SHALL return typed retryable backpressure rather than a server error under transient pressure

When device enrollment genuinely cannot proceed because of transient resource
pressure, the reference SHALL return a typed retryable response rather than an
untyped server error.

#### Scenario: Enrollment encounters transient connector-instance write pressure

- **WHEN** an enroll cannot proceed because of transient connector-instance write
  pressure
- **THEN** the reference SHALL return an HTTP 503 typed as retryable with a
  retry-after signal
- **AND** SHALL NOT return an untyped HTTP 500 that reads as a server fault.
