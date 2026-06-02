# Tasks — add-connector-adaptive-lanes

## 1. Design And Dependency Gate

- [x] Confirm the queue substrate choice (`p-queue`, `Bottleneck`, or internal queue) against package Node version, ESM, dependency policy, and testability.
- [x] Document the queue substrate rationale in `design.md`.
- [x] Document the final algorithm constants and rationale in `design.md`.
- [x] Decide where lane telemetry is emitted and update this change if the surface becomes durable or user-facing.
- [x] Decide whether distributed lane enforcement is out of scope for the current single-process reference target or needs a follow-up design.

## 2. Shared Utility

- [x] Add a connector-runtime adaptive lane utility under `packages/polyfill-connectors/src/`.
- [x] Keep per-request retry delegated to `retryHttp` or connector-provided request functions.
- [x] Support lane names, min/initial/max concurrency, queue bounds, per-attempt timeout integration, min/max delay, jitter, cooldown, `Retry-After`, cancellation, progress hooks, telemetry hooks, fake sleep, and fake random.
- [x] Ensure retry attempts are scheduled through the same lane capacity/cooldown path as first attempts.
- [x] Ensure the lane never stages connector state, commits cursors, or emits RECORD/STATE/DONE directly.
- [x] Support separate lane instances for login/manual-action recovery, browser navigation, API listing, and bulk hydration.

## 3. Deterministic Simulator And Tests

- [x] Add simulator tests for fixed quotas, hidden account quotas, `Retry-After`, transient network failures, long cooldowns, changing quotas, pathological item failure, and cancellation.
- [x] Assert active work never exceeds configured effective concurrency.
- [x] Assert queued work is bounded and fails or pauses explicitly rather than growing without limit.
- [x] Assert rate-limit pressure prevents concurrent retry storms in one lane.
- [x] Assert concurrency increases only after sustained clean success.
- [x] Assert run cancellation clears queued work, prevents scheduled retries, and aborts active attempts where supported.
- [x] Assert bulk lane saturation does not block a separate login/manual-action lane.
- [x] Assert all tests run with fake clock/random and do not depend on wall time.

## 4. ChatGPT Pilot

- [x] Replace ChatGPT conversation detail hand-rolled serialized loop with the adaptive lane.
- [x] Preserve current pressure by configuring `initialConcurrency = 1` and `maxConcurrency = 1` for the first live pilot.
- [x] Preserve existing ChatGPT retry/backoff progress copy or replace it with clearer lane-aware progress.
- [x] Verify the connector still does not emit stream `STATE` or advance durable state on failed required detail collection.
- [x] Verify concurrent or out-of-order lane completions cannot change the ChatGPT cursor calculation.
- [x] Fast-open the source-pressure circuit on a bare 429 (no `Retry-After`) after `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` attempts instead of burning the full 12-attempt budget, via a generic `retryHttp` `shouldKeepRetrying` hook and a connector-local predicate (`shouldKeepRetryingChatGptDetail`). Motivated by the 2026-06-02 bare-429 live probe; see `design.md` → Live Evidence.
- [x] Keep the full retry budget for 429-with-`Retry-After` and `502/503/504` (honest server-bounded waits), and keep successful 200 detail processing unchanged.

## 5. Validation

- [x] Run `pnpm --dir packages/polyfill-connectors typecheck`.
- [x] Run targeted connector tests for `http-retry`, adaptive lane, and ChatGPT.
- [x] Run `openspec validate add-connector-adaptive-lanes --strict`.
- [x] Run `openspec validate --all --strict` or document any pre-existing unrelated failures.
- [ ] Run one Docker ChatGPT live pilot with fixture capture enabled. **Deferred — hot-account blocked.** The 2026-06-02 probe left the live account/source bucket throttled (20–67% 429 across two cooldown probes), so a clean cold-state pilot is not safe to run now without risking escalation on the real account. Run from a genuinely cold start (no recent ChatGPT load) per the probe report's reproduce section. Owner-only live action.
- [ ] Compare live telemetry against the serialized baseline: no retry exhaustion, no burst above configured lane cap, clear cooldown/progress messages, and successful cursor commit on terminal success. **Deferred — depends on the cold-state pilot above.** The fast-open and circuit behavior are proven deterministically (see §5 targeted tests); only the live wall-clock and cooldown-copy comparison remain.
- [x] Verify lane observability redacts or omits secret-bearing URLs, headers, cookies, and request bodies.
- [x] Add deterministic tests for the bare-429 fast-open: `retryHttp` `shouldKeepRetrying` early-stop (generic), and `shouldKeepRetryingChatGptDetail` boundary + real-`retryHttp` 3-attempt exhaustion (connector).

## 6. Follow-Up Gate

- [ ] Decide whether ChatGPT may raise `maxConcurrency` above `1` after live evidence. **Owner-only; blocked on cold-state live evidence.** The 2026-06-02 probe shows even the minimal serial policy is throttled on the current account, so concurrency MUST stay at `1` until a cold-state run produces clean evidence.
- [ ] Identify the next connector candidate only after its throttle bucket and required/optional stream semantics are explicit.
