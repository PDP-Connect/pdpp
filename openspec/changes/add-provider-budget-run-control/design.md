# Design: add-provider-budget-run-control

## Context

Collection Profile runtimes call opaque third-party providers. The rate-limit
policy is unknown at design time: providers may signal throttling via 429 with
`Retry-After`, 429 without headers, 503, silent slow-down, or not at all until
an account is suspended (RFC 6585). The minimal correct control model must be
correct in all four cases.

Five prior-art lanes were completed before this design:

| Lane | Key findings |
|------|-------------|
| Crawler politeness | Token bucket > leaky bucket for catch-up; one-way error ratchet; conservative start before first signal; per-host isolation |
| Data-sync checkpoints | Monotonic commit-gated cursor; opaque cursor tokens; bounded `[start, end)` windows; catch-up vs. steady-state separation |
| Retry/circuit-breaker | Ratio-based retry budget (≈20% of requests); full-jitter backoff; circuit breaker composition; bulkhead per provider |
| Rate-control algorithms | GCRA (ITU-T I.371) as the precise pacing primitive; rate-based AIMD for adaptive fill-rate adjustment; CUBIC (AWS SDK); concurrency-AIMD is separate and lower-confidence |
| Checkpoint/queue models | Slice = smallest replayable unit (22/25 adversarially verified); lease-heartbeat for job ownership; time as outer bound; item count as soft inner ceiling; budget check at slice boundaries only |

All five lanes independently converged on the same structural model. The design
below follows consensus findings; parameter defaults (retry ratio, backoff cap,
circuit-breaker timeout) are empirical and must be tuned per provider.

The interim synthesis initially stated that the rate-control and checkpoint-queues
lanes were "not found." Both lanes completed with full reports; the final evidence
audit (`ri-provider-budget-final-evidence-audit-v1-report.md`) verified and
incorporated their findings. The structural conclusions are unchanged; confidence
levels and GCRA specificity are updated accordingly.

## Design Decisions

### D1. Request attempt as the primary budget unit

The request attempt (one outbound call, success or failure) is the universally
applicable budget unit. It is countable without provider cooperation, maps
directly to rate-limit risk, and is the unit all surveyed pacing algorithms
(Scrapy, AWS SDK, Stripe token bucket) use. Bytes and weighted-cost units are
second-order refinements applicable when the provider's cost model is known; they
are out of scope for the minimal design.

The per-run request cap bounds total volume. The per-provider token bucket bounds
rate. Both are required; neither subsumes the other.

### D2. GCRA/token-bucket for inter-request pacing

GCRA (Generic Cell Rate Algorithm, ITU-T I.371) is the precise recommended
pacing primitive. GCRA(I, L) tracks a Theoretical Arrival Time (TAT): a request
conforms if `t_a ≥ TAT − L`; on conform, `TAT = max(TAT, t_a) + I`. During
idle gaps `t_a > TAT`, TAT resets to `t_a + I`, preventing unbounded credit
accumulation — an important correctness property for collectors that pause
between scheduled runs. Effective bucket capacity is `I + L`.

A naïve token bucket TB(r, B_max) is a valid approximation and is easier to
implement; the key behavioral requirement is that accumulated credit MUST NOT
grow unboundedly during pauses. Leaky bucket is wrong for a catch-up workload:
it enforces a constant output rate, preventing burst acceleration. (Supported by:
Stripe docs, Kong analysis, AWS Builder's Library, brandur.org — four independent
sources.)

Pacing is **per-provider**: a slow or rate-limited provider does not starve
collection from other providers (bulkhead principle; supported by all production
crawler and SDK references).

**Rate-based AIMD** (Additive Increase, Multiplicative Decrease) governs dynamic
fill-rate adjustment: the fill rate grows additively on successful responses and
decreases multiplicatively on throttle signals (429, 503, elevated latency). This
finds the provider's true rate ceiling from below without requiring explicit quota
configuration. (Supported by: AWS SDK adaptive mode, AWS SDK CUBIC, Google SRE
client-side throttling. Confidence: High — primary standards RFC 5681, ITU-T
I.371; production implementations.)

**Concurrency-limit AIMD** (adjusting the in-flight request concurrency limit
rather than the fill rate) is a related but distinct mechanism. The rate-control
lane (Netflix/concurrency-limits) flagged a documented failure mode when the hard
rate limit is near the sampling window size (Issue #72); the checkpoint-queues
lane independently rated this claim as low-confidence with no confirmed primary
sources. Concurrency-limit AIMD is therefore NOT normative in this design.
Implementations MAY compose a concurrency limiter with the rate-bucket gate
(Stripe/Vector pattern), but this is an implementation option, not a requirement.

### D3. One-way error ratchet on pacing delay

Error responses — regardless of how fast they complete — MAY NOT decrease the
inter-request delay. A fast 429 completing in milliseconds is not a signal that
the provider is healthy. The delay MAY only increase (or remain unchanged) in
response to errors. (Scrapy AutoThrottle explicit rule; Common Crawl 429
handling.)

### D4. Conservative start before any adaptive signal

Before the first response from a provider, the runtime uses a conservative
starting delay rather than sending requests at full rate. This prevents cold-start
hammering before any latency or error data is available. (Scrapy
`AUTOTHROTTLE_START_DELAY`, RFC 9309 fail-safe on policy unavailability.)

### D5. Retry budget as a ratio-based token bucket, distinct from per-request count

Per-request retry limits (attempt count) do not bound total retry volume across
concurrent or sequential requests. The correct constraint is a token-bucket retry
budget scoped to the run: retries consume tokens; when the bucket is empty, no
further retries are issued and the run defers the remainder as a resumable gap.

Retry budget capacity is approximately 20% of the per-run request cap (Linkerd
default; AWS SDK retry quota). The refill rate is proportional to successes.
Full jitter (`sleep = random(0, min(cap, base × 2^attempt))`) is mandatory to
prevent synchronized retry waves. (Supported by: AWS canonical post, Google
Cloud, Polly, Linkerd — four independent sources.)

Only retryable status codes trigger retry budget consumption: 429, 408, 5xx.
Client errors (4xx other than 429/408) indicate a structural problem with the
request; retrying them wastes budget without prospect of success.

### D6. Circuit breaker as a fast-fail gate above the retry layer

A circuit breaker prevents calls to a known-unhealthy provider. Composition
order (innermost to outermost): Request → Retry → Circuit Breaker → Rate Limiter
→ Timeout → Bulkhead. When the circuit breaker is Open, errors propagate
immediately without consulting the retry budget. (Resilience4j, Azure, Polly
consensus.)

Circuit breaker state transitions (Closed → Open, Open → Half-Open, Half-Open
→ Closed or Open) are observable for operator health views.

### D7. Wall-clock as outer deadline, not rate control or source-pressure signal

Wall-clock caps the maximum real time a single run occupies. It prevents hangs
on slow or unresponsive providers and makes run scheduling predictable. It does
NOT control inter-request rate (the token bucket does) and its expiry is NOT a
source-pressure signal.

When the wall-clock deadline expires, the run defers the remainder as a resumable
gap with a reason that is NOT in the source-pressure reason set. The checkpoint
advances only to the last durably written page. (Supported by all five prior-art
lanes; no source uses wall-clock as the primary rate-control mechanism.)

Wall-clock is checked between fetch attempts, not mid-fetch, so an in-flight
request is never interrupted.

### D8. Commit-gated monotonic checkpoint; slice as the atomic unit

The checkpoint (cursor/bookmark) advances only after a durable write is
confirmed (equivalent to Glue `job.commit()`, Singer bookmark promotion). A
crash before commit leaves the checkpoint unchanged; at-least-once re-delivery
from the last safe position is the correct guarantee.

The **slice** is the canonical checkpoint granularity unit (Airbyte Protocol;
adversarially verified 22/25 in the checkpoint-queues lane). A slice is the
smallest replayable logical partition — one page, one date range, one entity
batch. State is persisted atomically after a full slice completes. The
time-and-item budget check happens at slice boundaries, never mid-slice;
attempting to checkpoint mid-slice adds complexity with no recovery benefit
(the slice replays anyway).

An **in-flight marker** (`currently_syncing`-style flag or equivalent) prevents
concurrent runs from corrupting the cursor. If a second collector instance
attempts to run the same connector while another instance holds the marker, the
second instance should yield (Singer/Meltano; SQS visibility timeout; Step
Functions task token — all three converge on exclusive job ownership during
collection). This design does not mandate a specific lease mechanism but requires
that the runtime prevent concurrent cursor advancement for the same connector.

Cursors are stored as opaque provider-issued tokens. Reconstructed offset cursors
produce skips and duplicates when the source mutates between pages.
(Gusto/Design Gurus; Debezium LSN invalidation failure case.)

The checkpoint at the time a budget is exhausted reflects the last durably
written page (the last completed slice), never the last attempted page.

### D9. Budget exhaustion is planned defer, not error or source pressure

When any budget axis (request cap, wall-clock, retry budget) is exhausted, the
run emits a named, resumable gap record carrying a reason NOT in the
source-pressure reason set, and does not arm the source-pressure cooldown
governor. A deferred run is not a provider failure; it is a planned handoff.

The gap record must carry: the stream identifier, the cursor at the stop point,
and a reason that distinguishes budget exhaustion from source pressure. The
scheduler can re-enqueue the deferred remainder without operator intervention.

### D10. Catch-up vs. steady-state mode separation

When a connector distinguishes historical backfill from incremental collection,
the two modes use separate bookmarks and are scheduled separately. A catch-up
run does not advance the steady-state incremental cursor. Merging the two
corrupts the incremental baseline and makes it impossible to distinguish "fully
synced" from "partially backfilled". (Singer `end_value`-style bounded catch-up;
dlt incremental separation; Fivetran priority-first sync.)

## Non-Goals

- Not a change to the PDPP Core protocol, grant semantics, or Authorization
  Server behavior.
- Not a change to the manifest schema or connector public listing.
- Not a wire-format change. Existing `DETAIL_GAP` and `STATE` messages are
  sufficient.
- Not a specification of provider-specific numeric defaults (fill rate, burst
  depth, retry ratio, circuit-breaker timeout). Those are tuned per provider
  using adaptive feedback; this change specifies the structural requirements,
  not the parameter values.
- Not a requirement to implement a distributed multi-client concurrency
  coordinator. If multiple concurrent collector processes share a provider
  credential, each runs its own per-provider token bucket. The rate-control lane
  (arXiv 2510.04516 ATB/AATB) found no lightweight coordination primitive in
  the surveyed literature below the full AATB telemetry sidecar. Multi-client
  shared-credential coordination is explicitly deferred to a future requirement.
- Not a scheduling-dispatch policy change.

## Risks and Tradeoffs

- **Parameter tuning is empirical.** The design specifies structural requirements
  (token bucket, AIMD, ratio-based retry budget); correct parameter values depend
  on each provider's actual throttle behavior. Implementation must tune these
  with live data.
- **Catch-up vs. steady-state separation adds bookmark complexity.** Connectors
  that currently use a single cursor must manage two. The alternative (merging
  modes) corrupts the incremental baseline — a worse failure.
- **Circuit breaker minimum-throughput guard is required.** Without a minimum
  throughput threshold before the breaker can open, a cold start with zero
  requests generates a false-open and treats the provider as unhealthy. This
  is a nuanced implementation constraint noted as a risk.
- **Wall-clock overrun by one in-flight fetch** (D7) is intentional and bounded
  by the per-fetch timeout; it is acknowledged rather than hidden.
- **Multiple connectors sharing a provider credential.** If two concurrent
  collector runs call the same provider with the same account, the per-provider
  token bucket must be shared across those runs or each runs its own bucket at
  half rate. The rate-control lane found no lightweight coordination primitive
  in the literature short of a full telemetry sidecar; this change explicitly
  defers multi-client coordination to a future requirement.
- **Concurrency-limit AIMD not validated.** If the target provider enforces
  concurrent-connection limits rather than request-rate limits, rate-based AIMD
  will not adapt the right control variable. The surveyed literature (Netflix
  concurrency-limits Issue #72, checkpoint-queues low-confidence rating) does not
  provide sufficient basis to mandate concurrency-limit AIMD. A follow-up research
  pass (Envoy adaptive concurrency filter) would close this gap if needed.

## Acceptance Checks

- A run with no budget configured behaves byte-for-byte as before (default-off).
- When a request cap is exhausted, the run emits a resumable gap record with a
  reason not in the source-pressure reason set, and does not arm the
  source-pressure cooldown governor.
- When the wall-clock deadline expires, the run defers the remainder with the
  same honest gap record; the checkpoint reflects the last durably written page.
- When the retry budget is exhausted, the run defers rather than spins.
- Inter-request delay is per-provider, not global; a slow provider does not
  delay requests to other providers.
- Error responses do not decrease the inter-request delay (one-way ratchet).
- The checkpoint never advances past the last page for which a durable write was
  confirmed.
- When catch-up and steady-state modes are separate, a catch-up run does not
  advance the steady-state incremental cursor.
- Circuit breaker state changes are observable for operator health views.
