# Design: connector adaptive lanes

## Context

`run_1778641079040` showed that a large ChatGPT run could durably ingest records, stage state, then fail late when a conversation detail request exhausted retry after upstream throttling. The reference runtime's cursor behavior was correct: failed bounded runs do not commit staged cursors. The connector's pressure model was weaker: fixed detail concurrency plus per-request retry allowed multiple retry loops to contend with one account-level upstream throttle bucket.

The immediate mitigation serialized ChatGPT `/conversation/{id}` detail fetches with jittered delay. That is the safe baseline, but not a reusable design for the connector fleet.

## Prior Art

The design uses high-adoption queue/retry primitives as references but does not delegate the adaptive policy wholesale:

- `p-queue` is the best-fit queue substrate if we add a dependency: current, high-adoption, ESM, supports concurrency, interval caps, backpressure, pause/resume, and queue introspection. It does not infer adaptive concurrency from upstream failures.
- `p-limit` is extremely adopted and useful for plain bounded concurrency, but too small for launch pacing, progress, and queue observability.
- `Bottleneck` is mature and powerful for known quotas, `minTime`, `maxConcurrent`, reservoirs, grouping, and distributed limiting. It is attractive if the reference later needs distributed quotas, but it still does not decide PDPP's opaque-upstream adaptation policy.
- `p-retry` and the existing `retryHttp` helper cover per-request retry semantics, not cross-request pressure control.
- `rate-limiter-flexible` is better for protecting our own service or enforcing known quotas than for outbound private API pacing.
- Netflix `concurrency-limits` is strong prior art for adaptive concurrency control, but its Java/service focus and latency-gradient algorithms are heavier than the first reference connector need. Its key lesson is still useful: adaptation must be feedback-driven and conservative under loss.

Conclusion: use a hardened queue primitive for mechanics if it materially reduces code, but own the PDPP-specific lane policy: connector bucket naming, result classification, owner-visible progress, cursor-safety boundaries, cancellation semantics, fixture-friendly telemetry, and conservative defaults for opaque private APIs. The OpenSpec requirement should define lane semantics, not vendor-specific package APIs.

Decision 2026-05-14: use `p-queue` for the first implementation's local queue mechanics. It is current, high-adoption, native ESM, and directly supports mutable concurrency, per-operation timeouts, `AbortSignal` cancellation, queue introspection, saturation/backpressure signals, and strict interval caps if needed later. This is not a commitment to expose `p-queue` as the connector API; it remains an implementation detail behind PDPP lane semantics.

## Model

An adaptive lane is a connector-local scheduler for one upstream throttle bucket.

```
connector code
  │
  ▼
adaptive lane: chatgpt.conversationDetail
  ├─ queue / max concurrency
  ├─ queue capacity / fail-fast policy
  ├─ inter-launch delay and jitter
  ├─ retry feedback classification
  ├─ cooldown / Retry-After
  ├─ cancellation / AbortSignal propagation
  ├─ conservative concurrency adaptation
  └─ progress + telemetry hooks
  │
  ▼
upstream request function
```

The lane owns *when* work starts. The request helper owns *whether a single request retries*. The connector owns *what records are emitted* and *when state is staged*. The runtime owns *whether staged state commits* after terminal `DONE`.

Retries must be admitted through the same lane as first attempts. A retry path that bypasses lane capacity or cooldown would recreate the retry-storm failure mode this change is meant to prevent.

## API Shape

The intended connector-facing shape is:

```ts
const lane = createAdaptiveLane({
  name: "chatgpt.conversationDetail",
  initialConcurrency: 1,
  minConcurrency: 1,
  maxConcurrency: 3,
  minDelayMs: 1500,
  maxDelayMs: 3000,
  pressureMinDelayMs: CHATGPT_RATE_LIMIT_BASE_DELAY_MS,
  pressureMaxDelayMs: 15 * 60_000,
  classifyOutcome,
  emitProgress,
  emitTelemetry,
  random,
  sleep,
});

await lane.runAll(conversations, async (conversation) => {
  return api.fetch(`/conversation/${encodeURIComponent(conversation.id)}`);
});
```

Outcome classes should be intentionally small:

- `ok`
- `retryable`
- `rate_limited`
- `terminal`

The first implementation should allow connector-specific result metadata, but telemetry must redact sensitive URLs, record keys, bearer tokens, cookies, and platform identifiers unless the connector explicitly supplies a safe label.

## Adaptive Policy

The first policy should be conservative loss-based additive-increase/multiplicative-decrease:

- Start at `initialConcurrency`, normally `1` for opaque browser/private endpoints.
- Never go below `minConcurrency` or above `maxConcurrency`.
- Enforce a queue capacity or equivalent fail-fast bound so degraded upstreams do not create unbounded memory or time debt.
- Treat `rate_limited` as strong pressure: cut effective concurrency to `minConcurrency`, apply cooldown, and respect `Retry-After` when present.
- Treat repeated `retryable` network/server failures as pressure and reduce concurrency quickly.
- Increase concurrency only after a sustained clean-success window and never during cooldown.
- Use jitter for inter-launch delays so many connector runs do not synchronize.
- Prefer slower completion over late-run retry exhaustion for first-run backfills.

Implementation constants for the first tranche:

- Default retry attempts in the lane utility are `1`; connectors may opt into lane-level retries, while ChatGPT keeps `retryHttp` as its per-request retry owner and holds the lane slot during that retry loop.
- The clean-success window defaults to `max(3, maxConcurrency)` and increases effective concurrency by `1`, capped at `maxConcurrency`.
- `rate_limited` feedback cuts effective concurrency directly to `minConcurrency`; other retryable/terminal pressure halves effective concurrency, floored at `minConcurrency`.
- Normal launch pacing is bounded by connector-provided `minDelayMs`/`maxDelayMs`; source-pressure cooldown is separately bounded by `pressureMinDelayMs`/`pressureMaxDelayMs` so a connector can keep successful launches paced in seconds while backing off pressured sources in minutes.
- ChatGPT keeps `retryHttp` as the per-request retry owner, but retry callbacks SHALL report intermediate pressure into the lane so pressure is visible even when the individual request eventually succeeds.
- The ChatGPT pilot uses `initialConcurrency = 1`, `maxConcurrency = 1`, `minDelayMs = 1500`, `maxDelayMs = 3000`, and ChatGPT rate-limit retry bounds for pressure cooldown, preserving serialized normal fetches while applying meaningful source-pressure cooldown.

Latency-gradient or Vegas-style algorithms are deferred. They may be useful for well-behaved public APIs, but they can give false confidence against opaque anti-abuse systems where latency is not the signal that matters.

## Cursor And State Boundaries

The lane must not know about durable cursors. It may return item-level outcomes, but it must not stage state or decide whether a run succeeds. This preserves the bounded-run invariant documented in `design-notes/bounded-run-checkpoints-and-rate-limit-retry-2026-05-13.md`: a failed or cancelled run must not durably advance past required uncollected data.

Connectors may decide to emit `SKIP_RESULT` for optional data or fail for required data, but that is connector semantics, not lane semantics.

For cursor batches, connectors must wait for all lane-managed work that can affect the cursor boundary to settle before emitting the stream `STATE`. Concurrent completion order must not change the cursor calculation, and a failed required item must not masquerade as complete coverage.

## QoS Separation

High-volume bulk hydration should not starve recovery-critical work. The design should support separate lanes for at least:

- login and manual-action recovery
- browser navigation
- API listing
- bulk detail hydration

The first ChatGPT pilot only needs a bulk detail lane, but the utility should not bake in a single global connector queue that prevents later separation.

## Telemetry And Progress

The lane should emit owner-usable progress without leaking secrets:

- lane name
- active count
- queued count
- effective concurrency
- configured min/max concurrency
- selected delay
- cooldown reason
- outcome class
- retry count or retry-exhausted marker
- `Retry-After` presence and bounded duration
- concurrency decrease/increase events

These events are reference/runtime observability artifacts, not Collection Profile messages unless a later change promotes them. If lane events enter `_ref` run timelines, they should be runtime-authored evidence distinct from connector-authored diagnostics.

Decision 2026-05-14: the first implementation exposes lane telemetry/progress as injectable hooks on the utility. It does not create a new durable `_ref` timeline event type. The ChatGPT pilot adds low-cardinality lane progress only for lane start, cooldown/retry/concurrency pressure, cancellation, queue rejection, and safe terminal errors; ordinary per-item success remains covered by the existing `Synced X / N conversations` progress. Promoting lane decisions into first-class `_ref` timeline events remains a follow-up if live pilots show connector-authored progress is not enough for operator diagnosis.

## Cancellation

Cancellation must be complete:

- queued work is cleared
- scheduled retries are not launched
- sleeps/cooldowns resolve promptly
- active attempts receive `AbortSignal` when the underlying operation supports it
- terminal run handling remains the runtime's authority

This matters because parked manual actions, Docker restarts, and owner cancellation should not leave hidden retry loops active against an upstream account.

## Simulator-First Validation

The utility should be proven in a deterministic simulator before ChatGPT adoption. The simulator should model:

- fixed request-per-window quotas
- hidden account-level quota shared by concurrent requests
- `Retry-After`
- random transient network failures
- long cooldowns
- changing quotas
- one pathological item that always fails
- cancellation while work is queued or sleeping
- bulk lane saturation while a recovery lane remains available

Acceptance is behavioral, not cosmetic: the simulator must prove no configured caps are exceeded, `Retry-After` is respected, retry storms are avoided, and cursor ownership stays outside the lane.

## Alternatives Considered

### Keep Per-Connector Fixed Concurrency

Rejected as the general answer. It is simple, but every connector would rediscover the same pressure/cooldown bugs and telemetry gaps.

### Use Bottleneck Directly Everywhere

Deferred. Bottleneck is strong for known quotas and could become the substrate, but direct use would still leave connector authors to design their own adaptive feedback loops and cursor boundaries.

### Full Adaptive Concurrency Library

Rejected for the first tranche. The high-confidence part is not a generic algorithm; it is the PDPP-specific separation between lane scheduling, per-request retry, connector emission, and runtime cursor commit.

### Sub-Run Durable Checkpoints

Deferred. That is a separate durability design with harder correctness implications. Adaptive lanes should reduce retry exhaustion before changing checkpoint semantics.

## Rollout

1. Add the lane utility and deterministic simulator tests.
2. Pilot ChatGPT conversation detail fetches with `initialConcurrency = maxConcurrency = 1`, preserving current serialized pressure.
3. Use telemetry and fixture capture to compare against the current serialized implementation.
4. Only after a successful live run, consider raising ChatGPT `maxConcurrency` to `2` or `3` behind config.
5. Reuse the utility in other connectors only after each connector names its upstream throttle bucket and required/optional data semantics.

## Open Questions

- Should adaptive lane config eventually be manifest-declared, or remain connector-code configuration?

## Deferred Questions

- Distributed lane enforcement is out of scope for this first reference implementation. The current target is single-process connector correctness. If the reference later runs multiple connector workers for the same owner/source, add a follow-up design for shared lane state via Redis, database-backed quotas, or a runtime coordinator.
