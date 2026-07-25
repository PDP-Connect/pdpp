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
enrollment — either by resubmitting the SAME code, when it is already
`consumed` (the response was lost in transit), or by exchanging any code
(including a FRESH one, when a prior code for the same physical collector
expired before it could be retried) for the SAME physical collector
identity — and obtain a usable credential, without duplicating device,
source-instance, or connector-instance identity for that collector. Identity
resolution for a pending code SHALL key on the collector's STABLE binding
(owner, connector, source kind, local binding name) — never on the
enrollment code's own id, which is fresh per code mint and therefore cannot
serve as a durable identity anchor across multiple codes for the same
collector. The source kind (`local_device` or `browser_collector`, derived
from the connector's manifest bindings) SHALL be resolved BEFORE the
identity decision and SHALL be part of the same stable key as the binding
name, so identity resolution and adoption for one source kind can never
observe, block on, or adopt orphaned or live identity belonging to a
different source kind — even when the owner, connector, and local binding
name are otherwise identical.

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

#### Scenario: A fresh code for the same binding adopts an expired code's partial-write identity with no manual cleanup

- **WHEN** a prior enrollment attempt for a code durably created the device,
  connector instance, and source instance rows for a given (owner, connector,
  source kind, local binding), then failed before the code was consumed; that
  code subsequently expires WITHOUT being retried; and a FRESH enrollment
  code is minted and exchanged for the SAME connector, SAME source kind, and
  SAME local binding
- **THEN** the reference SHALL resolve the fresh code's enrollment to the SAME
  device, connector instance, and source instance the prior attempt's partial
  write created — NOT create a second, independently-orphaned device — and
  SHALL NOT raise a duplicate-key error on the connector-instance identity
- **AND** the reference SHALL rotate the device credential and consume the
  fresh enrollment code
- **AND** the expired code SHALL remain rejected/fail-closed and SHALL NOT be
  retroactively marked consumed or bound to any device
- **AND** no operator action outside the enrollment API (e.g. direct database
  access) SHALL be required to complete this enrollment.

#### Scenario: Orphaned identity is never adopted across a different source kind

- **WHEN** a prior enrollment attempt durably created an orphaned device
  (identity created, never consumed) for a given (owner, connector, local
  binding) under one source kind — e.g. `local_device` — and a SEPARATE
  enrollment (fresh or retried code) resolves to the SAME owner, connector,
  and local binding name but a DIFFERENT source kind — e.g.
  `browser_collector`
- **THEN** the reference SHALL NOT adopt the other kind's orphaned identity
- **AND** SHALL resolve its own identity independently — adopting an orphan
  of its OWN kind if one exists, or minting a fresh device otherwise
- **AND** the two source kinds SHALL end with independent device, connector
  instance, and source instance identities, never merged, even though the
  owner, connector, and local binding name are identical.

#### Scenario: Genuinely concurrent enrollment attempts for the same pending code or binding converge on one identity

- **WHEN** multiple enrollment attempts race for the same still-pending code,
  or for different codes minted for the same still-uncompleted (owner,
  connector, source kind, binding), such that more than one attempt could
  observe "no existing identity yet" before any commits
- **THEN** the reference SHALL serialize the identity-resolution decision
  through a durable, database-backed mechanism (not a process-local lock,
  which provides no guarantee across concurrent requests or processes) keyed
  on the full (owner, connector, source kind, binding) tuple
- **AND** every attempt SHALL converge on exactly one device, one connector
  instance, one source instance, and exactly one active credential —
  regardless of how many requests race or in what order they arrive.

#### Scenario: A consumed enrollment code is replayed after it expired

- **WHEN** a device re-submits a consumed enrollment code whose expiry has passed
- **THEN** the reference SHALL reject the request as expired
- **AND** SHALL NOT issue or rotate any credential.

#### Scenario: A consumed enrollment code is replayed for a different binding or device

- **WHEN** an enrollment code that was consumed by one device/binding is replayed
  in a way that does not resolve to that same device and binding
- **THEN** the reference SHALL reject the request
- **AND** SHALL NOT issue a credential for a different device or binding.

#### Scenario: A declined consumed-code replay is never treated as a first enrollment

- **WHEN** a CONSUMED enrollment code's idempotent-resume attempt is declined
  (e.g. the bound device was revoked)
- **THEN** the reference SHALL reject the request explicitly
- **AND** SHALL NOT fall through to first-time enrollment logic, which would
  create a new, permanently-unclaimable device identity for a code that can
  never successfully consume it.

#### Scenario: A pending code with no prior attempt is not misrouted into the resume path

- **WHEN** a pending enrollment code has no existing orphaned device for its
  (owner, connector, binding) — a genuine first-time enrollment, not a resume
  of a partial write
- **THEN** the reference SHALL enroll it through the normal first-enrollment
  path, creating a new device, credential, connector instance, and source
  instance as usual.

#### Scenario: A fresh enrollment for an already-completed binding mints a new device, not an adopted one

- **WHEN** a physical collector's binding already has a LIVE, completed
  enrollment (a device with at least one enrollment code successfully
  consumed for it), and a genuinely new enrollment code is exchanged for that
  SAME binding
- **THEN** the reference SHALL mint a NEW device identity for this enrollment
  — it SHALL NOT adopt the existing live device, which remains a separate,
  independently-managed identity
- **AND** the reference SHALL resume the SAME connector instance for that
  binding rather than creating a second one.

#### Scenario: Distinct local bindings for the same connector never share identity

- **WHEN** two different physical collectors (distinct local binding names)
  enroll for the same connector and owner
- **THEN** the reference SHALL resolve each to its OWN distinct device,
  connector instance, and source instance
- **AND** neither binding's identity resolution SHALL ever adopt or reference
  the other's identity, including under concurrent or repeated enrollment.

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
