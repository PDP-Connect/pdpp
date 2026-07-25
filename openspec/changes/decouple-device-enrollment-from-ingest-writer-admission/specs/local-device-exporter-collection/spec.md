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

### Requirement: Enrollment SHALL be idempotent so a transport failure or partial write does not strand the one-time credential

Because the server cannot know whether a committed enroll response reached the
client, and because a failure can occur AFTER identity is durably created but
BEFORE the enrollment code is consumed, a device SHALL be able to retry
enrollment with the same enrollment code — whether that code is already
`consumed` (the response was lost in transit) or still `pending` with identity
already partially or fully created by a prior attempt — and obtain a usable
credential, without duplicating device, source-instance, or connector-instance
identity. The retry SHALL be accepted only when it resolves to the same device
and binding a prior attempt for that exact code already established.

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

#### Scenario: A device retries a still-PENDING code after a prior attempt created identity but failed before consume

- **WHEN** a prior enrollment attempt for a given code durably created the
  device, connector instance, and source instance rows but failed (write
  pressure, transport drop, process restart) before the code was consumed, so
  the code remains `pending` while the identity rows persist, and the SAME
  code is re-submitted
- **THEN** the reference SHALL resolve the retry to the SAME device, connector
  instance, and source instance the prior attempt created — NOT create a
  second device or a second source instance, and SHALL NOT raise a duplicate-
  key error on the connector-instance identity
- **AND** the reference SHALL rotate the device credential and consume the
  enrollment code, exactly as a retry of an already-consumed code does
- **AND** genuinely concurrent retries or first attempts for the same still-
  pending code SHALL converge on exactly one device and exactly one active
  credential, regardless of how many requests race.

#### Scenario: A consumed enrollment code is replayed after it expired

- **WHEN** a device re-submits a consumed enrollment code whose expiry has passed
- **THEN** the reference SHALL reject the request as expired
- **AND** SHALL NOT issue or rotate any credential.

#### Scenario: A consumed enrollment code is replayed for a different binding or device

- **WHEN** an enrollment code that was consumed by one device/binding is replayed
  in a way that does not resolve to that same device and binding
- **THEN** the reference SHALL reject the request
- **AND** SHALL NOT issue a credential for a different device or binding.

#### Scenario: A pending code with no prior attempt is not misrouted into the resume path

- **WHEN** a pending enrollment code has no existing device row (a genuine
  first-time enrollment, not a retry of a partial write)
- **THEN** the reference SHALL enroll it through the normal first-enrollment
  path, creating a new device, credential, connector instance, and source
  instance as usual.

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

#### Scenario: An identity write on the enroll path hits a duplicate-key conflict

- **WHEN** a raw duplicate-key (unique-violation) error surfaces from an enroll
  identity write, as defense-in-depth even though the idempotent-resume path
  is designed to make this unreachable
- **THEN** the reference SHALL return an HTTP 503 typed as retryable with a
  retry-after signal
- **AND** SHALL NOT return an untyped HTTP 500 that reads as a server fault.
