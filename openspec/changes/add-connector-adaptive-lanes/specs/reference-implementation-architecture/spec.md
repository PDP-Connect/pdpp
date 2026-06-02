## ADDED Requirements

### Requirement: Connector runtime SHALL provide adaptive lanes for upstream throttle buckets
The reference implementation's polyfill connector runtime SHALL provide a reusable adaptive lane utility for connector-local outbound work that targets an upstream throttle bucket. A lane SHALL bound concurrency, bound queued work, apply inter-launch pacing, accept connector-provided outcome classification, respect bounded `Retry-After` when provided, and expose deterministic timing hooks for tests.

#### Scenario: Connector schedules work through a lane
- **WHEN** a connector schedules multiple upstream requests through an adaptive lane
- **THEN** the lane SHALL NOT start more concurrent work than its current effective concurrency allows
- **AND** the lane SHALL NOT exceed its configured maximum concurrency
- **AND** the lane SHALL NOT allow queued work to grow without an explicit configured bound or pause/fail-fast policy

#### Scenario: Upstream reports rate limiting
- **WHEN** a lane receives an outcome classified as `rate_limited`
- **THEN** the lane SHALL reduce effective concurrency conservatively
- **AND** the lane SHALL apply a cooldown before launching additional work for the same upstream throttle bucket
- **AND** the lane SHALL respect a bounded `Retry-After` value when one is provided

#### Scenario: Clean successes continue
- **WHEN** a lane observes a sustained connector-configured window of clean outcomes
- **THEN** the lane MAY increase effective concurrency gradually
- **AND** the lane SHALL NOT increase beyond its configured maximum concurrency

### Requirement: Retries SHALL remain lane-governed
Retry attempts for lane-governed work SHALL obey the same lane capacity, pacing, cooldown, queue, and cancellation controls as first attempts.

#### Scenario: Request retries after a transient failure
- **WHEN** a lane-governed request receives a retryable network, server, or throttle outcome
- **THEN** the retry SHALL NOT bypass the lane's effective concurrency, cooldown, or queue bound
- **AND** the lane SHALL NOT create multiple concurrent retry loops for the same upstream throttle bucket beyond the configured lane capacity

#### Scenario: Run is cancelled while lane work is pending
- **WHEN** a run using adaptive lanes is cancelled or reaches a terminal failure before queued lane work starts
- **THEN** queued work SHALL be cleared or rejected
- **AND** scheduled retries SHALL NOT launch after cancellation
- **AND** active attempts SHOULD receive cancellation through `AbortSignal` or an equivalent mechanism when the underlying operation supports it

### Requirement: Connectors SHALL treat unbounded throttling as a source-bucket signal
When an upstream returns a retryable throttle response that carries no bounded backoff hint (for example HTTP 429 with no `Retry-After`), a connector SHALL be able to stop retrying that single request before exhausting its full per-request retry budget, so that a per-account throttle does not cause one request to spend a large retry budget against an already-pressured upstream. A bounded backoff hint, when present, SHALL still be honored on the connector's normal retry budget.

#### Scenario: Bare throttle response without a backoff hint
- **WHEN** a lane-governed request receives a throttle outcome (such as HTTP 429) that carries no `Retry-After` or equivalent bounded backoff hint
- **THEN** the connector MAY stop retrying that request after a small bounded number of attempts rather than exhausting its full per-request budget
- **AND** the connector SHALL surface the resulting pressure as resumable gap/deferred state rather than silently dropping required data
- **AND** required items deferred by this fast-open SHALL NOT be represented as complete cursor coverage

#### Scenario: Throttle response carries a bounded backoff hint
- **WHEN** a lane-governed request receives a throttle outcome that carries a bounded `Retry-After` or equivalent hint
- **THEN** the connector SHALL respect the bounded hint on its normal retry budget
- **AND** the connector SHALL NOT treat the hinted wait as a fast-open source-bucket signal

### Requirement: Adaptive lanes SHALL stay outside cursor ownership
Adaptive lanes SHALL schedule connector work but SHALL NOT emit connector `RECORD`, `STATE`, or `DONE` messages and SHALL NOT decide whether a bounded run's staged state becomes durable.

#### Scenario: Required upstream item fails after retry budget
- **WHEN** a lane returns a terminal or exhausted outcome for an upstream item that the connector treats as required
- **THEN** the connector SHALL remain responsible for deciding whether to fail the run, emit `SKIP_RESULT`, or continue
- **AND** the lane SHALL NOT advance stream cursor state on the connector's behalf

#### Scenario: Lane work affects a cursor boundary
- **WHEN** a connector uses lane-managed work to collect records covered by a stream cursor boundary
- **THEN** the connector SHALL wait for all required lane-managed work for that cursor boundary to settle before emitting the corresponding stream `STATE`
- **AND** failed or skipped required items SHALL NOT be represented as complete cursor coverage

#### Scenario: A bounded run fails
- **WHEN** a bounded run using adaptive lanes fails before successful `DONE`
- **THEN** the existing runtime checkpoint-commit rules SHALL remain authoritative
- **AND** staged state SHALL NOT be durably committed merely because lane-managed work completed for some items

### Requirement: Adaptive lane observability SHALL be safe and bounded
Adaptive lanes SHALL expose progress or telemetry hooks sufficient to explain throttling behavior to the owner and to tests. Lane observability SHALL avoid leaking bearer tokens, cookies, request bodies, full sensitive URLs, or upstream record identifiers unless the connector supplies an explicitly safe label.

#### Scenario: Lane enters cooldown
- **WHEN** a lane enters cooldown because of upstream pressure
- **THEN** observability hooks SHOULD report the lane name, outcome class, effective concurrency, bounded delay, and cooldown reason
- **AND** the report SHALL avoid raw secret-bearing request details

#### Scenario: Tests use fake timing
- **WHEN** lane behavior is tested
- **THEN** tests SHALL be able to inject fake sleep and fake randomness
- **AND** tests SHALL NOT depend on wall-clock sleeps to prove retry, pacing, or adaptation behavior

### Requirement: Adaptive lanes SHALL support quality-of-service separation
The connector runtime SHALL allow connectors to use separate adaptive lanes for distinct upstream work classes so bulk collection does not starve recovery-critical work.

#### Scenario: Bulk hydration is saturated
- **WHEN** a connector's bulk hydration lane is at capacity or in cooldown
- **THEN** separate login, manual-action, browser-navigation, or listing lanes SHALL NOT be blocked solely because the bulk lane is saturated
