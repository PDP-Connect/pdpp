# Client-Side Rate Governance — Prior Art Research

**Status:** captured  
**Owner:** the owner Nunamaker  
**Created:** 2026-06-10  
**Sources:** AWS SDK Reference (docs.aws.amazon.com, fetched 2026-06-10), Netflix/concurrency-limits GitHub README (github.com, fetched 2026-06-10), Scrapy AutoThrottle docs v2.16.0 (docs.scrapy.org, fetched 2026-06-10), Envoy Adaptive Concurrency filter docs v1.39 (envoyproxy.io, fetched 2026-06-10), Google SRE Book Ch. 21 Handling Overload (sre.google, fetched 2026-06-10), Brandur/Stripe GCRA article (brandur.org, fetched 2026-06-10), Kong rate-limiting algorithms (konghq.com, fetched 2026-06-10), Finagle Clients documentation (github.com/twitter/finagle, fetched 2026-06-10), Stripe idempotency blog (stripe.com, fetched 2026-06-10), Temporal worker performance docs (docs.temporal.io, fetched 2026-06-10)

---

## Purpose

This document surveys how mature distributed systems implement client-side rate governance — the set of mechanisms that govern *how fast* a client sends requests to a rate-limited upstream. It is intended to inform the PDPP design decision of whether to deploy one shared "provider pacing" governor for all data-collection connectors (browser-automation and API), given that one connector (ChatGPT) already has a live-calibrated AIMD concurrency lane and a separate, as-yet-unwired GCRA rate-AIMD primitive exists.

**The failure mode to avoid:** two stacked governors — one controlling concurrency, one controlling inter-request rate — both delaying the same request, compounding wait times non-additively.

---

## 1. AWS SDK Adaptive Retry Mode

**Source:** https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html (fetched 2026-06-10)

**Algorithm.** AWS SDK v3 ships three retry modes: legacy, standard, and adaptive. Adaptive mode adds a *client-side rate limiter* on top of standard mode's exponential-backoff-plus-token-budget retry logic. The rate limiter implements a variant of TCP CUBIC congestion control adapted for HTTP request pacing. It tracks a `measured_tx_rate` (exponential moving average of successful sends per second) and a `fill_rate` (the current allowed send rate). On every throttling response (HTTP 429, `ThrottlingException`, `RequestLimitExceeded`, and equivalents), the SDK sets `fill_rate = measured_tx_rate × 0.7` (multiplicative decrease, factor 0.7) and records a timestamp of last throttle. Between throttling events, the fill rate grows via a CUBIC curve parameterized by time since last throttle and the rate at last throttle point — slow linear growth near the throttle ceiling, faster growth when far below it, slowing again as it approaches the historic ceiling. The token bucket controlling actual sends is replenished at `fill_rate` tokens per second. On each send attempt in adaptive mode, the SDK first checks the rate limiter; if the bucket is dry, the send is delayed (not just the retry). This means even *initial* requests may be queued, not just retries.

**Signal.** Throttling error responses only (HTTP 429, SDK-classified throttling codes). `Retry-After` headers are not used to drive the CUBIC rate; they are used only to set the minimum wait on the specific throttled retry. The rate limiter is driven by error frequency, not latency.

**Layer owned.** Rate (tokens/second). The retry layer — a separate token budget (default 500 tokens; transient errors cost 5, throttling errors cost 0 on retry) — is orthogonal: it caps total retry volume, while the rate limiter controls send velocity for all requests, initial and retry alike.

**Composing with other layers.** AWS's own guidance is explicit: the rate limiter operates *per SDK client instance* and gates both initial requests and retries. Retries pass through the same rate limiter as originals. This means retries automatically get throttled if the bucket is low, preventing retry amplification — they do not need a separate backoff guard because the rate limiter already introduces inter-request delay. The sequence is: rate-limiter check → send → error classification → retry-quota check → backoff → rate-limiter check again on retry. Double-delay is avoided because backoff only applies *after* a failed send; the rate limiter delay applies *before* the send attempt. They operate at different moments in the request lifecycle.

**Calibration/rollout.** AWS recommends adaptive mode only when a client targets a *single resource* at high volume (e.g., one DynamoDB table in a batch processor). For multi-resource or multi-tenant clients, a single shared rate limiter incorrectly conflates throttling on one resource with traffic to unaffected resources, causing unnecessary latency. Start with standard mode; enable adaptive only when throttling is frequent and predictable. The `measured_tx_rate` calculation requires a warm-up period; the bucket starts permissive and tightens only after the first throttle signal.

---

## 2. Netflix Concurrency-Limits (Gradient / Vegas Algorithms)

**Source:** https://github.com/Netflix/concurrency-limits (README, fetched 2026-06-10); library version 0.5.4 (December 2025)

**Algorithm.** Netflix's `concurrency-limits` library (3.6k GitHub stars) applies TCP congestion-control concepts to RPC and HTTP client concurrency. Rather than limiting *rate* (requests per second), it limits *in-flight concurrency* (simultaneous outstanding requests). Two main algorithms:

- **Vegas:** Estimates the bottleneck queue depth as `L × (1 − minRTT/sampleRTT)` where `L` is the current limit. At each sampling window boundary, the limit increases by 1 if queue depth < α (typically 2–3) or decreases by 1 if queue depth > β (typically 4–6). This is a direct port of the TCP Vegas congestion-control algorithm.

- **Gradient2:** Tracks divergence between a short-window and long-window exponential moving average of RTT. When the averages diverge (short window increases relative to long), this signals a queueing trend, and the algorithm *aggressively* reduces the limit. Designed to correct the bias and drift problems of minimum-latency measurements in the original Gradient algorithm by using averages rather than minimums.

**Signal.** Observed request latency (RTT) — specifically, a comparison of current sampled RTT against a baseline minimum RTT. No explicit error signals are required; latency increase is treated as the leading indicator of overload, consistent with TCP Vegas. The Gradient2 algorithm also handles bursty traffic better than Vegas by smoothing with exponential averages.

**Layer owned.** Concurrency (in-flight request count). Not rate. The library explicitly does *not* control requests per second; it controls how many requests are allowed to be outstanding simultaneously. Rate emerges from `concurrency_limit / mean_latency` (Little's Law), but is not directly enforced.

**Why concurrency rather than rate.** Rate limits assume a known, stable service capacity. Concurrency limits are self-calibrating: if service latency increases (due to load, GC pauses, downstream pressure), the limit automatically decreases, even without explicit error responses. Rate limits require knowing the right number upfront; concurrency limits discover it from observed behavior. For variable-latency services (browser automation, AI APIs), this is a critical advantage.

**Composing with other layers.** The library is designed for server-side protection of services *from* their clients, but the same algorithms apply client-side when calling an upstream. It integrates with gRPC interceptors and Servlet filters. Retries are considered separately: the library includes partitioned-limit support (e.g., 90% capacity to "live" traffic, 10% to "batch"), which prevents retry storms from consuming live capacity. Retries should share the same limiter as originals (not bypass it), otherwise a flood of retries can push in-flight count past the adaptive limit. The README notes that the servlet filter use case explicitly addresses protection from "retry storms."

**Calibration/rollout.** Start with a permissive initial limit (e.g., 4–20 depending on expected concurrency) and let the algorithm calibrate over dozens of requests. The Gradient2 algorithm is preferred over Vegas for production use due to better handling of latency outliers and traffic bursts. WindowedLimit wraps the core algorithm to only update on statistically significant windows (minimum request count per window).

---

## 3. Envoy Adaptive Concurrency Filter / Google SRE Ch. 21 Client-Side Throttling

### 3a. Envoy Adaptive Concurrency Filter

**Source:** https://envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter (Envoy v1.39-dev, fetched 2026-06-10)

**Algorithm.** Envoy implements the Netflix Gradient algorithm as an HTTP filter. A `minRTT` is periodically re-measured (default every 60 seconds, with jitter, sampling 50 requests at reduced concurrency to get a clean baseline). The *gradient* is computed as:

```
gradient = (minRTT + buffer) / sampleRTT
```

where `buffer = minRTT × buffer_pct` allows for normal latency variance without triggering a limit decrease. The concurrency limit is updated each sample window (default 100ms):

```
limit_new = gradient × limit_old + headroom
```

`headroom = sqrt(limit_old)` by default — ensures the limit can grow even when gradient ≈ 1. Requests exceeding the current limit are blocked (HTTP 503-equivalent upstream; the filter itself returns 503 to the caller). The gradient controller tracks: current concurrency limit (gauge), current gradient × 1000 (gauge, range 500–2000), current minRTT, and current sampleRTT.

**Signal.** Latency-derived, same as Netflix Vegas/Gradient. No explicit error codes needed. The periodic minRTT recalculation probes true baseline capacity without any server-side quota configuration.

**Layer owned.** Concurrency. The filter gates requests before they enter the upstream cluster; rate emerges from the concurrency limit divided by current latency.

**Composing with other layers.** Envoy's documentation recommends placing the adaptive concurrency filter *after* the health check filter in the chain. Retry logic (Envoy's retry filter or application-level retries) should be aware that a blocked request (503 from adaptive concurrency) is a local rejection, not an upstream error — retrying immediately would re-hit the same concurrency gate and add no information. A brief backoff before retrying a locally-rejected request prevents tight retry loops.

### 3b. Google SRE Book Ch. 21 — Adaptive Client-Side Throttling

**Source:** https://sre.google/sre-book/handling-overload/ (fetched 2026-06-10)

**Algorithm.** Google's approach, described in the SRE Book and deployed internally at scale, is *rejection-driven* rather than latency-driven. Each client task tracks, over a sliding 2-minute window:
- `requests`: total requests sent
- `accepts`: requests accepted by the backend (not rejected with "out of quota")

The probability that the client drops a request *locally* (before sending) is:

```
P(drop) = max(0, (requests − K × accepts) / (requests + 1))
```

where `K` is a multiplier (typically 2.0). When the backend is healthy and accepting all requests, `accepts ≈ requests/K` only after the buffer fills — at K=2, the client begins dropping only after 50% of requests are being rejected. This prevents the client from flooding a degraded backend with rejected requests that still consume server-side resources (even rejection has non-zero cost). Requests dropped locally increment `requests` but not `accepts`, providing a self-regulating feedback loop.

**Signal.** Backend rejection rate (out-of-quota errors, HTTP 429 equivalents). Unlike Envoy/Netflix, this does not require latency measurement; it requires knowing which responses represent quota rejection vs. other errors.

**Layer owned.** Rate-of-send (probabilistic). Not a hard cap; a probabilistic drop that increases smoothly as the rejection ratio worsens. This is a *rate* governor (controls how many requests leave the client per unit time) not a *concurrency* governor.

**Composing with other layers.** Google notes that this works best for clients that send requests at steady rates. For sporadic clients, the 2-minute window gives poor signal. Retries are counted as `requests` when sent; their outcomes feed `accepts` normally. The formula naturally absorbs retries — if retrying a rejected request, the new request increments `requests`, and the backend either accepts (incrementing `accepts`) or rejects again. No separate retry-rate limiter is needed; the overall throttle governs total outbound traffic volume.

**Calibration.** K=2 is Google's empirically derived default. Lower K means more aggressive client-side throttling (drops sooner); higher K means more traffic passes to the backend before dropping begins. The 2-minute window is a deliberate choice: long enough to smooth bursts, short enough to recover quickly when backend recovers. Google notes the approach is stable in production and does not require backend-side quota configuration to be visible to the client.

---

## 4. Scrapy AutoThrottle (Polite Scraping / Browser Automation Analog)

**Source:** https://docs.scrapy.org/en/latest/topics/autothrottle.html (Scrapy v2.16.0, fetched 2026-06-10)

**Algorithm.** AutoThrottle is Scrapy's built-in extension for polite crawling — the closest production analog to browser-automation rate control. The crawl begins at a configured start delay (`AUTOTHROTTLE_START_DELAY`, default 5s). After each response, a *target download delay* is computed:

```
target_delay = response_latency / AUTOTHROTTLE_TARGET_CONCURRENCY
```

The actual download delay for subsequent requests is the exponential moving average of the previous delay and the target:

```
new_delay = (prev_delay + target_delay) / 2
```

`AUTOTHROTTLE_TARGET_CONCURRENCY` (default 1.0) is the desired number of concurrent requests to the target domain. Setting it to 1.0 means: maintain one in-flight request; the delay between launches is calibrated so that the next request fires approximately when the previous one completes. A value of 2.0 doubles throughput by aiming for two concurrent requests. The delay is clamped between `DOWNLOAD_DELAY` (hard minimum, default 0) and `AUTOTHROTTLE_MAX_DELAY`.

**Signal.** Response latency (time from TCP connection establishment to first HTTP response header byte). Non-200 responses are treated as slow (their latency does not decrease the delay), providing a natural bias toward caution on errors without requiring error-specific logic.

**Layer owned.** Rate/pacing (inter-request delay). The extension also respects `CONCURRENT_REQUESTS_PER_DOMAIN` as a hard concurrency cap — AutoThrottle adjusts delay but cannot override the concurrent request ceiling. This is an explicit layering: AutoThrottle controls *pacing*, a separate setting controls *concurrency ceiling*.

**Composing with other layers.** Scrapy's retry middleware (`RetryMiddleware`) operates independently of AutoThrottle. Retries on HTTP 5xx or connection errors are queued by the retry middleware and re-enter the request scheduler; they consume concurrency slots like any other request. AutoThrottle sees their latency (which will be high for error responses) and adjusts the delay accordingly — failed retries naturally slow the crawl. There is no explicit integration between the two middlewares; they are designed to compose via the shared concurrency model (the Twisted reactor's in-flight count). This is the clean separation: *retry middleware decides if/when to retry; AutoThrottle decides the inter-request pacing independently*. They share a concurrency budget but do not have direct awareness of each other.

**Calibration/rollout.** Start with `AUTOTHROTTLE_TARGET_CONCURRENCY=1.0` and `AUTOTHROTTLE_START_DELAY=5s` for an unknown target. Increase target concurrency only after confirming the target accepts parallel load. The `AUTOTHROTTLE_DEBUG=True` setting logs every delay adjustment, making calibration transparent. For the PDPP use case (browser automation against financial sites), the conservative start and the non-200 latency floor are especially relevant: error pages (login walls, CAPTCHAs) are slow, naturally increasing delay when the session is unhealthy.

---

## 5. GCRA in Practice (redis-cell, Cloudflare/Kong, brandur.org)

**Sources:** https://brandur.org/rate-limiting (fetched 2026-06-10); https://konghq.com/blog/engineering/how-to-design-a-scalable-rate-limiting-algorithm (fetched 2026-06-10)

**Algorithm.** The Generic Cell Rate Algorithm (GCRA, ITU-T I.371, originally specified for ATM network traffic shaping) tracks a *Theoretical Arrival Time* (TAT) — the time at which the last "cell" (request) is considered to have fully arrived in a conforming stream. For each request arriving at time `t_a`:
- If `t_a ≥ TAT − burst_tolerance (L)`: the request *conforms*; update `TAT = max(TAT, t_a) + I` (where `I = 1/rate` is the emission interval)
- Otherwise: the request is *non-conforming*; it should wait until `TAT − L` before being admitted

A key correctness property: during idle gaps where `t_a > TAT`, the TAT is reset to `t_a + I`, *not* allowed to accumulate credit unboundedly. This prevents a client that pauses for hours from issuing a burst equal to hours × rate on resume — a critical property for scheduled/intermittent workloads. The effective burst window is `I + L` (one emission interval plus the configured tolerance).

**Where GCRA is used client-side vs server-side.** GCRA is predominantly deployed *server-side* for quota enforcement (redis-cell, Kong, Cloudflare, nginx rate_limit module). The brandur.org article (Stripe engineering, 2015) describes GCRA as the correct algorithm for *server-side* API rate limiting, contrasting it with the naive "time-bucketed" approach used by GitHub's public API. On the *client side*, GCRA is the right algorithm when the client needs to *self-rate-limit* its outgoing traffic to comply with a known quota — e.g., a client that has been told its quota is 100 req/min and wants to pace evenly rather than fire all 100 at the start of the minute.

**Client-side GCRA is appropriate when:**
1. The rate quota is *known* (given by the server or contract).
2. The client wants *smooth pacing* rather than burst-then-wait.
3. The workload is intermittent/scheduled (the TAT reset prevents burst accumulation).

**Client-side GCRA is inappropriate when:**
1. The rate quota is *unknown* and must be discovered from error signals (use AIMD instead).
2. The relevant constraint is *concurrency*, not rate (use a semaphore or Gradient/Vegas limit).
3. The client does not know which error codes signal quota exhaustion vs. other failures.

**Composing with retries.** When GCRA is used client-side, retries on quota-rejection errors (`429`) should consume GCRA tokens in addition to any backoff delay — they represent real rate consumption. However, retries on transient errors (network failures, 5xx) typically *do not* represent real quota consumption and should be exempt from the GCRA pacing constraint. The recommended pattern (verified across Kong docs, brandur.org, and the PDPP OpenSpec design): separate the *pacing gate* (GCRA) from the *retry budget* (token bucket or ratio). GCRA paces normal sends; the retry budget limits total retry volume regardless of pacing.

**Calibration.** Start with a conservative `burst_tolerance (L)` of 1–3 emission intervals. For unknown quotas, start at a low fill rate and increase additively on success, decrease multiplicatively on throttle (AIMD on top of GCRA). The AIMD layer adjusts the `I` parameter dynamically. `redis-cell` implements GCRA in a Redis module with atomic CAS operations; for single-process use (no shared state), a plain in-memory TAT variable suffices.

---

## 6. Finagle Retry Budgets + Temporal Worker Rate Limits

### 6a. Finagle Retry Budgets

**Source:** https://github.com/twitter/finagle/blob/develop/doc/src/sphinx/Clients.rst (fetched 2026-06-10)

**Algorithm.** Finagle (Twitter's RPC framework) introduces a *RetryBudget* that governs total retry volume independently of per-request retry policies. The default budget allows approximately **20% of total requests to be retried**, plus a flat floor of 10 retries per second (to protect low-volume clients from starvation). The budget is a token bucket shared across all in-flight requests from a client. A retry attempt consumes a budget token; tokens are replenished at 0.2× the current request rate. When the budget is depleted, retries are *not* attempted — the client returns the error immediately. This prevents retry storms: if 10% of requests fail and all retry once, the effective request volume is 110% of normal — acceptable. If 100% of requests fail and all retry 3 times, volume is 400% — a storm. The budget makes this second scenario impossible at the client level.

**Relationship to pacing.** Finagle's retry budget is *not* a pacing mechanism; it is a *budget* (count of retries available). Pacing — inter-request delay — is a separate concern in Finagle, handled by backoff policies (exponential, decorrelated jitter). The retry budget and backoff policy compose cleanly because they operate on different dimensions: budget controls *whether* to retry, backoff controls *when* to retry. Neither interferes with the other.

**Calibration.** 20% retry budget is Twitter's empirically validated default across hundreds of services. For services with very high inherent error rates (>20%), the budget effectively stops retrying — which is the right behavior (retrying into a degraded service at 80% error rate amplifies load). The 10 retries/second floor prevents the percentage-based budget from becoming `0` for extremely low-traffic clients.

### 6b. Temporal Worker Rate Limits

**Source:** https://docs.temporal.io/dev-guide/worker-performance (fetched 2026-06-10)

**Architecture.** Temporal workers have two orthogonal rate-limiting knobs:
- `maxWorkerActivitiesPerSecond`: client-side rate limit on activities *polled by* a worker
- `maxTaskQueueActivitiesPerSecond`: server-side rate limit enforced by the Temporal server

Additionally, `maxConcurrentActivityTaskExecutions` controls the concurrent slot count. These three are independent levers: slots control concurrency, `maxWorkerActivitiesPerSecond` controls rate. Temporal's docs note that if you see underutilized workers with high `schedule_to_start` latency, you likely have `maxWorkerActivitiesPerSecond` set too low — the rate limiter is gating polling even when slots are available. The solution is to remove or raise the rate limit, not to add more workers. This is a documented anti-pattern of double-constraining: setting both a concurrency limit and a rate limit lower than what the concurrency limit permits.

**Lesson for PDPP.** If you have a concurrency semaphore (AIMD lane) *and* a rate limiter (GCRA), you must ensure the rate limiter's effective throughput ceiling is *above* the throughput that the concurrency semaphore would naturally produce at normal latency. Otherwise the rate limiter becomes the binding constraint and the concurrency semaphore has no effect — or both constrain in different regimes, producing non-obvious combined behavior.

---

## Transferable Patterns

1. **Separate the layers by signal type.** Rate governors respond to error-code signals (429s, quota rejections); concurrency governors respond to latency signals (RTT increase). They should not share signal inputs or control outputs.

2. **One governor owns one dimension.** Pick either rate *or* concurrency as the primary governor for a given upstream; do not deploy both independently. If you need both, make one *derived from* the other (e.g., a concurrency cap that implies a rate via Little's Law).

3. **Retries must pass through the same gate as originals.** AWS, Finagle, and Netflix all route retries through the same limiter as first attempts. Exempting retries from pacing leads to retry storms that amplify exactly the load signal that triggered retrying.

4. **Rate budgets limit *volume*; pacing limits *velocity*.** A retry budget (Finagle's 20% rule) prevents total retry count from exploding. A pacing governor (GCRA, CUBIC) prevents send velocity from exceeding the upstream's absorption rate. Both are needed; neither replaces the other.

5. **Conservative start, signal-driven ascent.** All surveyed systems start at a fraction of maximum capacity and increase only on signal (successful responses, time elapsed without throttle). AWS CUBIC, Scrapy AutoThrottle, Netflix Gradient — all start slow. Never start at the maximum configured rate.

6. **Non-200 responses must not reduce delay.** Scrapy's explicit rule — error response latency does not permit shortening the inter-request delay — prevents a tight error loop from accidentally increasing send rate when the session is broken.

7. **Backoff and pacing delay are not additive when sequenced correctly.** AWS demonstrates the key sequencing: pacing gate fires *before* a send attempt; backoff fires *after* a failed send. They operate at different lifecycle points. If both delay the same request (pacing gate after backoff sleep), delays stack. The fix is to apply backoff when scheduling the retry, then apply the pacing gate when actually sending.

8. **Per-provider (per-domain) isolation is mandatory.** All scraping and multi-backend SDK systems isolate rate state per upstream host. A slow or throttled upstream must not bleed its rate state into calls to a different provider.

9. **GCRA is a *smoothing* primitive, not a *discovery* primitive.** GCRA is optimal when the quota is known. When quota is unknown, layer AIMD on top to dynamically adjust the GCRA fill rate — AIMD discovers the ceiling; GCRA enforces smooth pacing within it.

10. **A shared limiter across dissimilar resources is an anti-pattern.** AWS adaptive mode's documented caveat: a single rate limiter shared across multiple unrelated resources will over-throttle the healthy ones when one is throttled. The limiter granularity must match the throttling granularity of the upstream (per-account, per-domain, per-session).

11. **Concurrency limits are self-calibrating; rate limits need explicit calibration.** Concurrency limits (Netflix Gradient, Envoy adaptive concurrency) discover the right value from observed latency without pre-configuration. Rate limits (GCRA, token bucket) require either a known quota or an AIMD outer loop to discover it. For unknown-quota upstreams, concurrency limits are lower-friction.

12. **Temporal's anti-pattern warning: rate limit ≥ concurrency × (1/mean_latency).** If the rate limiter's throughput ceiling is *below* what the concurrency semaphore would naturally achieve, the rate limiter is the binding constraint and the concurrency limit has no effect. Ensure the two limits are consistent, or use only one.

---

## Layering Doctrine

Across all surveyed systems, a consistent three-layer model emerges:

### Layer 1 — Retry budget (count)
**What:** Maximum total retries as a fraction of requests (Finagle: 20% + 10/s floor).  
**Signal:** Error type (retryable vs. non-retryable).  
**Goal:** Prevent retry amplification from turning a partial failure into a load spike.  
**Does not** interact with rate or concurrency — it gates *whether* a retry is attempted at all.

### Layer 2 — Send governor (rate or concurrency — choose one primary)
**What:** Either a rate governor (GCRA/token-bucket + AIMD, AWS CUBIC) or a concurrency governor (Netflix Gradient/Vegas, Envoy adaptive concurrency). Not both independently.  
**Signal:** Rate governor responds to error codes (429, quota rejection). Concurrency governor responds to latency (RTT increase).  
**Goal:** Keep the upstream's load within its absorption capacity.  
**Timing:** Fires *before* the send attempt (pre-flight gate). This is the key sequencing rule that prevents it from stacking with backoff.

### Layer 3 — Retry backoff (delay)
**What:** Exponential backoff with jitter, or explicit Retry-After header compliance.  
**Signal:** Specific error on a specific request.  
**Goal:** Space out the retry of a specific failed request so the upstream has time to recover.  
**Timing:** Applied *after* a failed send, when scheduling the next attempt. The retry re-enters Layer 2 when it fires — it does not bypass the send governor.

### Preventing double-delay stacking

The surveyed systems avoid stacking through two mechanisms:

**Mechanism A — Sequential lifecycle separation.** Backoff (Layer 3) runs *after* a failure to determine *when* the retry enters the queue. The send governor (Layer 2) runs *before* the send to gate actual transmission. Because they fire at different lifecycle points, a retry that sleeps 2 seconds (backoff) then waits 0.5 seconds (pacing gate) incurs 2.5 seconds total — additive but not multiplicative. The dangerous pattern is applying both at the *same* point (e.g., sleeping for backoff + GCRA hold inside the same wait loop), which can produce indefinite stacking if both governors independently compute non-zero delays.

**Mechanism B — Single governing dimension.** Systems choose *either* rate *or* concurrency as the primary governor for a given upstream. AWS adaptive mode governs rate; Netflix Gradient governs concurrency. Envoy governs concurrency. When both are deployed for the same upstream (as Temporal warns against), the two constraints must be *consistent*: the rate limit must be at or above the throughput the concurrency limit would naturally produce at normal latency. If they are inconsistent, only the tighter constraint matters — the other is dead code — and the dead constraint creates confusion without benefit.

### Application to PDPP

PDPP's ChatGPT connector already has a live-calibrated AIMD concurrency lane (Layer 2, concurrency-signal variant). The existing GCRA ProviderPacing primitive (Layer 2, rate-signal variant) would be a *second* Layer 2 governor over the same upstream. To avoid double-stacking:

- **Option A (recommended by surveyed prior art):** Use only the concurrency lane (AIMD, already calibrated), and add GCRA only if an explicit quota is provided by the upstream (i.e., GCRA becomes a compliance layer against a known ceiling, not a discovery mechanism). In this case, GCRA's fill rate must be set above the throughput the concurrency lane naturally achieves.
- **Option B:** Retire the concurrency AIMD lane and replace it with GCRA + rate-AIMD. GCRA provides smooth pacing; rate-AIMD discovers the quota ceiling. This is the AWS CUBIC / brandur.org approach and is appropriate for API connectors (known error codes). For browser-automation connectors, latency signal is more reliable than error-code signal, which favors the concurrency lane.
- **Option C (anti-pattern):** Deploy both governors independently with separate signal loops. Avoid — per Temporal's documented anti-pattern, two independent governors over the same upstream produce non-obvious combined behavior and are effectively a double-delay machine when both are active simultaneously.

The double-delay failure mode is most likely to appear if: (a) the AIMD concurrency lane blocks a request due to in-flight saturation, *and* (b) the GCRA gate then additionally holds the unblocked request for its inter-arrival interval. The fix is mechanical: the GCRA gate should be the *sole* pre-flight check; concurrency tracking should be used as a *signal input* to the AIMD rate adjustment, not as an independent blocking gate. The AIMD adjusts the GCRA fill rate; the GCRA gates sends. One gate, two signal inputs.
