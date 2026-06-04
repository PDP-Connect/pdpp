# Design: connector adaptive lanes

## Context

`run_1778641079040` showed that a large ChatGPT run could durably ingest records, stage state, then fail late when a conversation detail request exhausted retry after upstream throttling. The reference runtime's cursor behavior was correct: failed bounded runs do not commit staged cursors. The connector's pressure model was weaker: fixed detail concurrency plus per-request retry allowed multiple retry loops to contend with one account-level upstream throttle bucket.

The immediate mitigation serialized ChatGPT `/conversation/{id}` detail fetches with jittered delay. That is the safe baseline, but not a reusable design for the connector fleet.

## Live Evidence

2026-06-02 A/B probe (evidence-only; report: `tmp/workstreams/chatgpt-current-ab-probe-report-2026-06-02.md`). Attached read-only over CDP to the live PDPP ChatGPT browser context. No connector code ran; no records were ingested.

- The conservative *serial* request policy — the connector's own minimal lane shape — hit a 10×429 early-stop ceiling after 26 detail attempts (16×200, 10×429, ~38% 429 rate). The session stayed authenticated; the list endpoint returned 200 throughout.
- **No `Retry-After` header was present on any 429.** ChatGPT's private detail endpoint returns *bare* 429s.
- Cooldown probes stayed elevated (67% at +60s, 20% at +3min): the throttle is per-account and recovers over minutes, not per-conversation.
- Batch-5 and profile A/B were deliberately not run: the account was already hot, so raising concurrency would confound the comparison and risk escalating the throttle on a real account.

Two design consequences, both addressed in this change:

1. A bare 429 is a signal about the whole account/source bucket, not the one conversation in hand. The previous code only opened the source-pressure circuit after a single conversation exhausted the full `CHATGPT_RATE_LIMIT_MAX_ATTEMPTS = 12` budget. With bare 429s and jittered exponential backoff to a 15-min cap, that first throttled conversation burns roughly 23–70 minutes (mid ≈ 47 min) of wall-clock retrying *the same conversation* against an already-hot account before the circuit opens and defers the rest. The fast-open (below) cuts that to ~6 s.
2. Because the server advertises no `Retry-After`, exponential backoff is flying blind; the only honest signal is the 429 itself and its cadence. The connector must drive backoff off the observed bare-429 cadence and degrade to resumable `DETAIL_GAP` state, not keep hammering.

This evidence does **not** support raising detail-lane concurrency while the account is hot. The least-aggressive serial policy is what was throttled; batching would be throttled at least as hard. ChatGPT `maxConcurrency` MUST stay at `1` in production until a genuinely cold-state live run produces clean evidence (see Tasks §6).

Later the same day (2026-06-02, ~20:20 UTC), a follow-up status-only probe set found the account had recovered to **cold**: 0/25 detail requests returned 429 across serial+batch-3, with batch-3 ~3.6x faster than serial on the same account (`tmp/workstreams/ri-chatgpt-throughput-policy-v2-probe-evidence.md`). This confirms the prior probe's recovery curve (38% -> 67% -> 20% over minutes) and shows the throttle is **per-account and time-varying**, not a fixed property of PDPP's request policy. The structural throughput gap (serial + 1.5-3s jitter vs. a modest batch with short inter-batch delay) is real and recoverable on a cold account, but the run-start account state is the hard variable.

2026-06-03 live connector probe (`run_1780452117753`, evidence: `tmp/workstreams/chatgpt-current-ab-probe-followup-2026-06-03.md`) tested the real connector with temporary owner-only probe env (`initialConcurrency=3`, `maxConcurrency=3`, `pause=500..1000ms`). The preflight's 3 serial status probes passed, but the detail lane immediately hit bare-429 pressure after 1-2 detail successes and failed honestly with recoverable detail gaps. Runtime safety held (`state_streams_committed=0`, `checkpoint_commit_status=not_committed`), but the throughput gate failed. Two design corrections follow:

1. Serial-only preflight is an insufficient proxy for burst safety. When the requested posture raises concurrency, preflight must include a bounded burst canary matching the requested concurrency before allowing the faster lane.
2. Pressure-deferred gap bookkeeping must not be classified as a clean successful fetch. Otherwise the adaptive lane learns upward from synthetic gap emissions while the upstream-pressure circuit is open.

## Cold-State Preflight

Because account pressure is time-varying, the gate on raising concurrency cannot be a one-time design decision. A run configured for a faster posture could still launch into a hot bucket. The cold-state preflight makes that escalation safe at run start:

- It runs **only** when the bulk detail lane is configured above the serial default (`maxConcurrency > 1`, i.e. the owner has set a `PDPP_CHATGPT_DETAIL_*_PROBE` knob for an A/B). When `maxConcurrency === 1`, it is skipped entirely, so production runs issue no preflight requests and preserve the serial baseline.
- It fires a few (default 3) **serial, status-only** GET detail probes for the first conversations through the connector's own browser-context transport, then replays the same ids as one bounded burst canary when requested concurrency is above 1. The probe necessarily targets conversation ids, but it does not parse response JSON, does not capture bodies, and does not emit records, titles, ids, tokens, cookies, or request bodies.
- A clean preflight lets the requested faster posture through. **Any** throttle (429/5xx, or a retry-exhausted fast-open circuit) forces the run back to the frozen serial posture (`1/1`) for that run. The preflight can only make a run more conservative.
- It is connector-local and deterministic under injected fetch/sleep tests. It deliberately re-fetches the first few conversations after the preflight; for an owner A/B this is a small documented cost and keeps the classifier on the same browser/auth path the lane will use.

This closes the gap the earlier hot-account probe could not close: the reason batch was declined was "cannot safely escalate against a possibly-hot account." The preflight resolves that at run start, while preserving the production default until an owner-run A/B clears the live gate.

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
- ChatGPT fast-opens the source-pressure circuit on a *bare* 429 (status 429 with no `Retry-After`). After `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` (currently `3`) bare-429 attempts on a single detail request, `retryHttp` exhausts and throws the same `ChatGptRecoverableRetryExhaustedError` it would on full-budget exhaustion, opening the existing observed-pressure circuit so the remaining tranche defers to resumable `DETAIL_GAP` instead of grinding the hot account. A 429 that *does* carry `Retry-After`, and `502/503/504`, keep the full `CHATGPT_RATE_LIMIT_MAX_ATTEMPTS` budget — those are honest, server-bounded waits, not blind account hammering. This is implemented as a generic `retryHttp` `shouldKeepRetrying` early-stop hook with a connector-local predicate; the source-pressure *policy* stays connector-owned.

Latency-gradient or Vegas-style algorithms are deferred. They may be useful for well-behaved public APIs, but they can give false confidence against opaque anti-abuse systems where latency is not the signal that matters.

## Cursor And State Boundaries

The lane must not know about durable cursors. It may return item-level outcomes, but it must not stage state or decide whether a run succeeds. This preserves the bounded-run invariant documented in `design-notes/bounded-run-checkpoints-and-rate-limit-retry-2026-05-13.md`: a failed or cancelled run must not durably advance past required uncollected data.

Connectors may decide to emit `SKIP_RESULT` for optional data or fail for required data, but that is connector semantics, not lane semantics.

For cursor batches, connectors must wait for all lane-managed work that can affect the cursor boundary to settle before emitting the stream `STATE`. Concurrent completion order must not change the cursor calculation, and a failed required item must not masquerade as complete coverage.

ChatGPT request minimization follows the same boundary: when both `conversations` and `messages` are requested, the connector lists the conversation index once from the older of the two stream cursors, then filters that shared list against each stream's own cursor. This removes duplicate `/conversations` pagination without allowing the parent stream to advance from the message cursor or the message stream to skip a detail row that is still needed for backfill.

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
