## ADDED Requirements

### Requirement: A provider request path SHALL have exactly one pre-flight send governor

SHALL the polyfill-runtime gate the velocity of requests to a single provider
through exactly ONE pre-flight send governor. The send governor is the only
component permitted to wait (sleep) before a request is transmitted. Either a
concurrency governor (AIMD lane) or a rate governor (GCRA/token-bucket) MAY be
the send governor for a given provider, but NOT both as independent pre-flight
gates. For unknown-quota providers the runtime SHALL prefer the self-calibrating
concurrency governor; a GCRA rate signal, when present, SHALL be folded into the
single governor's pre-flight wait as a delay input, NOT run as a second
independent pre-flight wait.

Run-control decision layers — the run budget (request/wall-clock cap), the
retry budget, and the circuit breaker — SHALL make synchronous admit/deny
decisions and SHALL NOT perform a pre-flight wait. Retry backoff SHALL fire only
after a failed send (post-failure), never inside the same pre-flight wait as the
send governor.

#### Scenario: One pre-flight wait source per admitted request

- **WHEN** a request to a provider is admitted and transmitted
- **THEN** exactly one pre-flight wait source SHALL have governed it (the single
  send governor)
- **AND** no decision layer (run budget, retry budget, circuit breaker) SHALL
  have added a second pre-flight wait

#### Scenario: GCRA pacing contributes a signal, not a second gate

- **WHEN** a provider has both an AIMD concurrency send governor and a GCRA
  pacing bucket configured
- **THEN** the GCRA pacing SHALL contribute its computed inter-request delay to
  the single send governor's pre-flight wait
- **AND** the effective pre-flight wait SHALL be the maximum of the governor's
  own delay and the pacing delay, NEVER their sum
- **AND** the GCRA pacing SHALL NOT perform its own pre-flight wait

#### Scenario: Two independent pre-flight gates is a spec violation

- **WHEN** a request path is composed such that both a concurrency governor and
  a rate governor independently wait before the same provider send
- **THEN** the composition SHALL be treated as a defect
- **AND** the two pre-flight waits SHALL be detectable as more than one wait
  source on the request path
- **AND** the runtime SHALL NOT ship a default configuration in which two
  pre-flight waits gate the same provider request

### Requirement: Retry-After SHALL be honored exactly without double-paying the wait

SHALL the polyfill-runtime, when a provider returns a throttle response carrying
a `Retry-After` header, wait the specified interval exactly once before
retrying. The runtime SHALL NOT add jittered backoff on top of the `Retry-After`
interval for that retry, and SHALL NOT also queue the same interval as a
pre-flight pacing wait on the next request. A throttle response MAY decrease the
send governor's fill rate (multiplicative decrease signal), but the
`Retry-After` interval itself SHALL be slept exactly once, in the retry layer.

#### Scenario: Retry-After is slept once, not stacked on backoff

- **WHEN** a request receives a retryable response with a `Retry-After` header
- **THEN** the runtime SHALL wait exactly the `Retry-After` interval before the
  retry
- **AND** it SHALL NOT add jittered exponential backoff on top of that interval
- **AND** it SHALL NOT re-impose the same interval as a pre-flight pacing wait on
  the subsequent request

#### Scenario: Throttle still feeds the fill-rate decrease signal

- **WHEN** a `Retry-After` throttle is observed and slept in the retry layer
- **THEN** the send governor's pacing fill rate MAY be decreased (one-way error
  ratchet) as a signal
- **BUT** the decrease SHALL NOT cause the slept `Retry-After` interval to be
  paid a second time

### Requirement: The retry layer SHALL bound retry volume with a ratio-based retry budget distinct from per-request attempts

SHALL the polyfill-runtime's shared retry helper accept an optional
ratio-based retry budget (a Finagle-style token bucket) that bounds total retry
*volume* across a run, distinct from and in addition to the per-request attempt
count. When a retry budget is configured and its tokens are exhausted, the retry
helper SHALL stop retrying immediately with the same terminal shape as
exhausting the per-request attempt count, so the run defers rather than spins.
When no retry budget is configured, only the per-request attempt count bounds
retries (prior behavior preserved). A retry-budget-driven stop SHALL carry a
reason that is NOT in the source-pressure reason set.

#### Scenario: Retry budget exhaustion stops retries before the attempt count

- **WHEN** a retry budget with capacity smaller than the per-request attempt
  count is configured
- **AND** a request keeps receiving retryable responses
- **THEN** the retry helper SHALL stop retrying once the retry budget is empty,
  before exhausting the per-request attempt count
- **AND** the terminal error SHALL be the same shape as attempt-count exhaustion

#### Scenario: No retry budget configured preserves attempt-count-only behavior

- **WHEN** no retry budget is configured on the retry helper
- **THEN** only the per-request attempt count SHALL bound retries
- **AND** the helper's behavior SHALL be unchanged from before a retry budget
  was available

### Requirement: 429-prone connectors SHALL route provider requests through the shared send governor and retry layer

SHALL provider connectors that previously hand-rolled `if (status === 429) throw
"<name>_rate_limited"` route their provider requests through the shared
send-governor + retry helper instead of growing local rate-handling code. The
shared helper SHALL preserve each connector's terminal rate-limit error string
so the runtime `retryablePattern` cross-run source-pressure deferral and
cooldown contract is unchanged. A connector MAY configure the helper with a
single bounded attempt so its immediate-throw behavior is byte-identical while
the Retry-After-honor capability is wired and available behind that configured
attempt count.

#### Scenario: Terminal rate-limit preserves the cross-run cooldown contract

- **WHEN** a migrated connector exhausts its retries against a 429
- **THEN** the shared helper SHALL throw the connector's existing
  `<name>_rate_limited` terminal error
- **AND** that error SHALL match the connector's `retryablePattern`
- **AND** the cross-run source-pressure cooldown SHALL arm exactly as it did
  before the migration

#### Scenario: A single bounded attempt preserves immediate-throw behavior

- **WHEN** a migrated connector configures the shared helper with one bounded
  attempt
- **AND** a provider returns 429
- **THEN** the helper SHALL make exactly one provider call and throw the terminal
  rate-limit error immediately
- **AND** raising the attempt count SHALL activate inline Retry-After honor and
  bounded backoff without changing the terminal contract

### Requirement: Budget-exhaustion defer reasons SHALL be disjoint from source-pressure reasons

SHALL every reason with which the shared provider-budget controller defers a run
(request-cap reached, wall-clock deadline, retry-budget exhausted, circuit open)
be disjoint from the source-pressure reason set that arms the cross-run cooldown
governor. Budget exhaustion is a planned stop, not a provider-driven rejection,
and SHALL NOT be misread as source pressure by the scheduler.

#### Scenario: No budget-exhaustion reason arms the source-pressure cooldown

- **WHEN** a run defers because a provider-budget axis is exhausted (request cap,
  wall-clock, retry budget, or open circuit)
- **THEN** the defer reason SHALL NOT be a member of the source-pressure reason
  set
- **AND** the cross-run source-pressure cooldown governor SHALL NOT be armed by
  that deferral
