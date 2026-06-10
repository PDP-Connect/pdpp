## ADDED Requirements

### Requirement: Polyfill-runtime runs SHALL apply per-provider GCRA-compatible token-bucket pacing distinct from the run-level request cap

SHALL the polyfill-runtime enforce inter-request rate to each provider using a
per-provider token bucket compatible with GCRA semantics (ITU-T I.371): credit
accumulated during idle or paused periods SHALL NOT exceed the burst tolerance
ceiling, preventing a burst on resume from an idle collector. The token bucket
SHALL control the rate at which requests are admitted to a provider; the
run-level cap SHALL control the total volume of requests per run. These two
controls are orthogonal and both SHALL be in effect when configured.

The pacing token bucket SHALL be per-provider: a slow, rate-limited, or
unresponsive provider SHALL NOT delay or starve requests to any other provider.

#### Scenario: Pacing and request cap coexist without substituting for each other

- **WHEN** a polyfill-runtime run has both a per-provider pacing configuration
  and a per-run request cap configured
- **THEN** the runtime SHALL enforce both controls independently
- **AND** exhausting the pacing bucket (waiting for tokens) SHALL NOT count as
  progress toward the request cap
- **AND** exhausting the request cap SHALL stop the run regardless of remaining
  pacing budget

#### Scenario: One provider being rate-limited does not affect another

- **WHEN** a runtime is collecting from two providers concurrently
- **AND** provider A returns a rate-limit signal (429 or equivalent)
- **THEN** the runtime SHALL apply backoff only to provider A's token bucket
- **AND** requests to provider B SHALL continue at provider B's current pacing rate

### Requirement: Polyfill-runtime pacing SHALL apply rate-based AIMD adaptive fill-rate adjustment

SHALL the polyfill-runtime apply Additive Increase / Multiplicative Decrease
(AIMD) adjustment to the per-provider token-bucket **fill rate** (the rate at
which tokens are generated). The fill rate SHALL increase additively on
successful responses and decrease multiplicatively on throttle signals. This is
rate-based AIMD — it adjusts the token generation rate, not the number of
in-flight concurrent requests. Concurrency-limit AIMD (adjusting the maximum
in-flight request count) is not required by this specification; implementations
MAY add a concurrency limit as an additional layer but it is not normative.

Error responses — regardless of how quickly they complete — SHALL NOT decrease
the inter-request delay (one-way error ratchet). Before the first response from
a provider, the runtime SHALL use a conservative starting delay rather than the
maximum available rate.

#### Scenario: Throttle signal causes multiplicative fill-rate decrease

- **WHEN** a provider returns a throttle signal (429, 503, or elevated latency
  indicating soft throttle)
- **THEN** the runtime SHALL decrease the fill rate of that provider's token bucket
  multiplicatively
- **AND** if a `Retry-After` header is present the runtime SHALL honor it exactly
  rather than adding additional delay on top of it
- **AND** the inter-request delay SHALL NOT decrease as a result of that response

#### Scenario: Successful responses cause additive fill-rate increase

- **WHEN** a provider returns successful responses over a sampling window
- **THEN** the runtime SHALL increase the fill rate of that provider's token bucket
  additively
- **AND** the fill rate SHALL NOT exceed the configured burst ceiling

#### Scenario: Conservative starting rate before first response

- **WHEN** the runtime begins its first requests to a provider in a run
- **AND** no prior latency or throttle signal has been observed for that provider
- **THEN** the runtime SHALL use a conservative starting delay
- **AND** it SHALL NOT begin at the maximum configured fill rate

### Requirement: Polyfill-runtime SHALL apply a run-level request cap that defers the remainder as a resumable gap

SHALL the polyfill-runtime support a per-run request cap (maximum number of
provider-attempt tokens consumed in one run). The generic runtime primitive
SHALL support an unbounded mode so callers can preserve prior behavior when no
budget is configured. Provider connectors SHOULD prefer adaptive pacing, finite
retry budget, circuit-breaker protection, and source-pressure deferral over
arbitrary fixed request-count defaults. A fixed request cap SHALL be an explicit
owner/system envelope and SHALL NOT be used as a substitute for adaptive
provider pacing: the cap bounds how much a run may attempt, while the
per-provider token bucket controls how fast requests are admitted. When a
configured request cap is reached, the runtime
SHALL stop launching new provider requests and SHALL emit a named, resumable
gap record for the remaining work, advancing the checkpoint only to the last
durably written position.

#### Scenario: No cap configured leaves a run unbounded and unchanged

- **WHEN** the request cap is not configured or resolves to no cap
- **THEN** no cap branch SHALL defer any record
- **AND** the run SHALL continue until natural completion or another stopping
  condition (wall-clock deadline, retry budget exhaustion)

#### Scenario: Request cap reached defers remainder as resumable gap

- **WHEN** a run has consumed its configured per-run request cap
- **THEN** the runtime SHALL stop launching new provider requests
- **AND** it SHALL emit a resumable gap record for the remaining work
- **AND** the checkpoint SHALL advance only to the last position for which a
  durable write was confirmed
- **AND** a subsequent run SHALL be able to recover and resume from that position

### Requirement: Polyfill-runtime SHALL enforce a wall-clock run deadline as an outer hang bound, not a rate-control mechanism

SHALL the polyfill-runtime support a per-run wall-clock deadline that bounds the
maximum real time a single run occupies. The generic runtime primitive SHALL
support an unbounded mode. A fixed wall-clock deadline SHALL be an explicit
owner/system envelope, not the default mechanism for hands-off provider
collection. The deadline SHALL NOT be treated as the mechanism for collecting
faster or slower. On expiry, the runtime SHALL emit a resumable gap record for the
remaining work and advance the checkpoint to the last durably written position.
The wall-clock deadline SHALL be checked between provider-fetch attempts, never
mid-fetch, so an in-flight request is not interrupted. The deadline MAY be
exceeded by at most the duration of one in-flight request, itself bounded by the
per-request timeout.

The wall-clock deadline is an outer safety bound — it is NOT a rate-control
primitive, SHALL NOT influence the per-provider pacing token bucket, and SHALL
NOT be used as the primary mechanism for governing inter-request intervals.

#### Scenario: Wall-clock deadline expires between fetches

- **WHEN** the elapsed run wall-clock reaches the configured deadline
- **AND** no provider request is currently in flight
- **THEN** the runtime SHALL stop launching new provider requests
- **AND** it SHALL emit a resumable gap record for the remaining work
- **AND** the checkpoint SHALL advance only to the last durably written position

#### Scenario: Wall-clock deadline expires during an in-flight request

- **WHEN** the elapsed run wall-clock reaches the configured deadline
- **AND** a provider request is currently in flight
- **THEN** the runtime SHALL allow that in-flight request to complete
- **AND** it SHALL check the deadline again before launching any further requests
- **AND** the wall-clock overrun SHALL be bounded by the per-request timeout

#### Scenario: Wall-clock deadline expiry does not affect pacing state

- **WHEN** a wall-clock deadline causes a run to stop
- **THEN** the per-provider token bucket fill rate SHALL be unchanged by the
  deadline expiry
- **AND** the next run for the same provider SHALL start from the same pacing
  state it would have without a wall-clock cap

### Requirement: Budget exhaustion SHALL produce a resumable gap record distinct from source-pressure signals

SHALL budget exhaustion — whether caused by a request cap, a wall-clock
deadline, or a retry budget — produce a named, resumable gap record whose reason
is NOT in the source-pressure reason set. Budget exhaustion is a planned stop,
not a provider failure. The gap record SHALL identify the stream, the cursor
position at the stop point, and a reason that distinguishes planned budget
exhaustion from provider-driven rejection. Budget exhaustion SHALL NOT arm the
cross-run source-pressure cooldown governor. Budget exhaustion SHALL NOT be
reported as a source error or as a signal that the provider is unavailable.

#### Scenario: Request cap exhaustion does not arm source-pressure cooldown

- **WHEN** a run stops because it reached its per-run request cap
- **THEN** the resumable gap record SHALL carry a reason not in the source-pressure
  reason set
- **AND** the source-pressure cooldown governor SHALL NOT be armed
- **AND** the operator dashboard SHALL NOT display the deferral as a provider error

#### Scenario: Wall-clock deadline expiry does not arm source-pressure cooldown

- **WHEN** a run stops because its wall-clock deadline expired
- **THEN** the resumable gap record SHALL carry a reason not in the source-pressure
  reason set
- **AND** the source-pressure cooldown governor SHALL NOT be armed

#### Scenario: Retry budget exhaustion defers the run rather than spinning

- **WHEN** a run's retry budget token bucket is exhausted
- **THEN** the runtime SHALL stop retrying and SHALL emit a resumable gap record
  for the remaining work
- **AND** the gap reason SHALL NOT be in the source-pressure reason set if the
  retry budget was a self-imposed run-level cap rather than a provider-driven
  rejection

### Requirement: Polyfill-runtime SHALL apply a ratio-based retry budget distinct from per-request attempt count

SHALL the polyfill-runtime bound retry amplification using a run-scoped retry
budget token bucket rather than only a per-request attempt count. The retry
budget SHALL limit retries to approximately 20% of the per-run request cap over
a sliding window (or a configurable equivalent). Retries SHALL consume retry
budget tokens; when the retry budget is empty, no further retries SHALL be
issued. Only retryable status codes (429, 408, 5xx) SHALL trigger retry budget
consumption; non-retryable client errors (4xx other than 429 and 408) SHALL NOT
consume retry budget and SHALL NOT be retried.

All retry delays SHALL use full jitter: `sleep = random(0, min(cap, base × 2^attempt))`.
When a `Retry-After` header is present, the runtime SHALL honor it exactly;
it SHALL NOT add additional backoff on top of the specified interval on the first
violation.

#### Scenario: Retry budget bounds total retry volume across a run

- **WHEN** a run encounters retryable errors on multiple sequential requests
- **THEN** the total number of retry attempts across the run SHALL be bounded by
  the retry budget
- **AND** when the retry budget is empty, subsequent retryable errors SHALL not
  trigger additional retry attempts

#### Scenario: Non-retryable errors skip the retry budget

- **WHEN** a provider returns a non-retryable 4xx (other than 429 or 408)
- **THEN** the runtime SHALL NOT retry that request
- **AND** the runtime SHALL NOT consume any retry budget tokens
- **AND** the runtime SHALL log the error and skip that record or request

#### Scenario: Retry-After header is honored exactly

- **WHEN** a provider returns a throttle response with a `Retry-After` header
- **THEN** the runtime SHALL wait at least the duration specified by `Retry-After`
  before retrying
- **AND** it SHALL NOT add additional delay on top of the header value on the
  first violation of that request

### Requirement: Provider-budget circuit transitions SHALL be durable run-scoped evidence

SHALL the polyfill-runtime expose circuit-breaker state transitions from the
shared provider-budget primitive as structured, run-scoped evidence. The evidence
SHALL identify the transition (`previous_state`, `state`), the generic trigger
and reason, and bounded run-control counters such as elapsed milliseconds,
request count, and retry-budget posture. The evidence SHALL be emitted or
persisted through the runtime's progress/spine path so operator health and run
timeline surfaces can derive circuit state without parsing connector-specific
prose.

Circuit-transition evidence SHALL be scoped by the runtime envelope to the run
and connector instance. It SHALL NOT be stored as long-lived connection state
and SHALL NOT include raw provider URLs, query strings, record identifiers,
conversation identifiers, cookies, bearer tokens, request bodies, response
payloads, or other secret/user-content-bearing details. Connector-specific code
SHOULD only classify provider outcomes and route them into the shared
provider-budget primitive.

#### Scenario: Open transition is recorded without connector-specific parsing

- **WHEN** a provider-budget circuit breaker changes from Closed to Open after
  provider throttle or failure observations
- **THEN** the runtime SHALL emit structured transition evidence containing the
  prior state, new state, generic reason, and bounded run-control counters
- **AND** operator health or timeline projection SHALL be able to identify the
  open circuit without parsing ChatGPT-specific or provider-specific prose

#### Scenario: Recovery transition is recorded without leaking provider details

- **WHEN** an Open circuit reaches its reset timeout and a Half-Open probe
  succeeds
- **THEN** the runtime SHALL record the Open → Half-Open and Half-Open → Closed
  transitions
- **AND** the evidence SHALL NOT contain the raw provider route, conversation ID,
  query string, cookie, bearer token, request body, or response body

#### Scenario: Another connector can reuse the primitive

- **WHEN** a different 429-prone connector adopts provider-budget run control
- **THEN** it SHALL be able to emit the same structured circuit-transition
  evidence by binding to the shared provider-budget primitive
- **AND** it SHALL NOT need to copy ChatGPT-specific circuit-state code

### Requirement: Polyfill-runtime checkpoint advancement SHALL be commit-gated, monotonic, and slice-aligned

SHALL the polyfill-runtime advance a connector's checkpoint (cursor, bookmark,
or equivalent state) only after a durable write for the corresponding records
has been confirmed. The checkpoint SHALL be monotonically non-decreasing. The
checkpoint at the time a run stops (for any reason, including budget exhaustion)
SHALL reflect the last position for which a durable write was confirmed, never
the last attempted position.

The atomic unit of checkpoint advancement is the **slice** — the smallest
replayable logical partition (one page, one date range, one entity batch). State
SHALL be persisted after a full slice completes; a mid-slice crash SHALL replay
that slice from its beginning. Budget checks (request cap, wall-clock deadline,
retry budget) SHALL be evaluated at slice boundaries, not mid-slice. The runtime
SHALL NOT attempt to checkpoint a partial slice.

The runtime SHALL prevent concurrent advancement of the same connector's
checkpoint by two simultaneous runs. An in-flight run SHALL hold an exclusive
ownership marker for the connector; a second attempt to run the same connector
SHALL yield until the marker is released.

Provider-issued opaque cursor tokens SHALL be stored as-is. The runtime SHALL
NOT reconstruct an offset-based cursor from record count or position, as
reconstructed cursors produce duplicates and skips when the source mutates
between pages.

#### Scenario: Checkpoint advances only after durable write confirmation

- **WHEN** a connector emits a STATE message advancing its cursor
- **THEN** the runtime SHALL persist that checkpoint only after the corresponding
  records have been durably written and acknowledged
- **AND** a run that crashes before durable write confirmation SHALL leave the
  checkpoint at the last successfully confirmed position
- **AND** the next run SHALL resume from that checkpoint without data loss

#### Scenario: Budget exhaustion checkpoint reflects last confirmed position

- **WHEN** a run stops because any budget axis (request cap, wall-clock, retry
  budget) is exhausted
- **THEN** the checkpoint persisted at that stop point SHALL correspond to the
  last page or record for which a durable write was confirmed
- **AND** it SHALL NOT correspond to the last page or record that was attempted
  but not yet confirmed

#### Scenario: Opaque cursor tokens are stored verbatim

- **WHEN** a provider issues an opaque pagination cursor token
- **THEN** the runtime SHALL store that token verbatim as the checkpoint value
- **AND** it SHALL NOT reconstruct a cursor by any formula (page offset, record
  count, or date range) unless the provider has no opaque token and a synthetic
  cursor is the only available checkpoint mechanism

#### Scenario: Concurrent run attempt yields to in-flight run

- **WHEN** a connector run is in progress and holds an exclusive ownership marker
- **AND** a second run is attempted for the same connector
- **THEN** the second run SHALL NOT begin collecting or advancing the checkpoint
- **AND** it SHALL yield until the first run completes and releases the marker

### Requirement: Polyfill-runtime SHALL separate catch-up and steady-state bookmarks when both modes exist

SHALL a polyfill-runtime that distinguishes historical backfill (catch-up) from
incremental collection (steady-state) maintain separate bookmarks for each mode.
A catch-up run SHALL NOT advance the steady-state incremental cursor. The
catch-up cursor advances only within the catch-up window; the steady-state cursor
advances only on incremental collection runs. This separation prevents a
partially-backfilled run from corrupting the incremental baseline.

This requirement applies only to connectors that explicitly distinguish catch-up
and steady-state phases. Connectors that use a single continuous cursor are not
subject to this requirement.

#### Scenario: Catch-up run does not advance the steady-state cursor

- **WHEN** a connector performs a catch-up run over a historical `[start, end)`
  window
- **THEN** the steady-state incremental cursor SHALL remain at its current value
  at the start of the catch-up run
- **AND** the steady-state cursor SHALL NOT advance as a side effect of the
  catch-up run completing

#### Scenario: Steady-state incremental run does not consume catch-up windows

- **WHEN** a connector performs a steady-state incremental run
- **THEN** it SHALL collect from its current steady-state cursor forward
- **AND** it SHALL NOT re-process records already covered by completed catch-up
  windows unless those records fall within the steady-state cursor's range

### Requirement: Polyfill-runtime detail-gap recovery SHALL drain eligible pending gaps without a semantic page cap

SHALL the polyfill-runtime treat pending detail-gap recovery as a drain loop:
within one logical run it SHALL continue recovering eligible pending detail gaps
until no eligible pending gaps remain, or until adaptive provider/run safety
stops the lane. Valid stop conditions include provider/run budget exhaustion,
retry budget exhaustion, an open circuit breaker, Retry-After or source-pressure
deferral, owner cancellation, or a terminal runtime failure. A storage read page
size, projection limit, or transport batch size SHALL NOT be treated as a
semantic per-run recovery cap.

Internal detail-gap pages SHALL be bounded for memory/backpressure safety. The
preferred bound is a serialized payload byte budget with page sizing adapted from
observed payload size. If the underlying storage substrate can only expose
row-limited candidate reads, that row limit SHALL be used only as an internal
candidate-read fallback; the runtime SHALL loop subsequent pages so the fallback
cannot cap recovery progress.

#### Scenario: More pending gaps than one internal page recover in one run

- **WHEN** a run starts with more eligible pending detail gaps than fit in the
  first internal page
- **AND** provider/run safety remains healthy
- **THEN** the runtime SHALL provide subsequent pending-gap pages to the connector
- **AND** the connector SHALL be able to recover more than one page in the same
  logical run
- **AND** the run SHALL NOT report the backlog caught up solely because the first
  page was exhausted

#### Scenario: Adaptive safety stops the recovery loop

- **WHEN** a pending-gap page cannot be fully recovered because provider/run
  safety defers one or more gaps
- **THEN** the connector SHALL stop requesting further pending-gap pages in that
  run
- **AND** it SHALL leave the unrecovered gaps durable and pending for a later run
- **AND** it SHALL NOT proceed to forward detail collection as if recovery had
  drained

#### Scenario: Byte-bounded pages split large payloads without capping progress

- **WHEN** pending detail-gap locators are large enough that only a few fit within
  the configured serialized payload byte budget
- **THEN** the runtime SHALL split the recovery handoff across multiple internal
  pages
- **AND** it SHALL continue paging until storage is drained or adaptive safety
  stops
