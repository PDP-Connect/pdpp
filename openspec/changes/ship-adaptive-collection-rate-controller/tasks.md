# Tasks: ship-adaptive-collection-rate-controller

## 1. Delete the launch-jitter floor as a rate floor

- [x] 1.1 Lower `CONVO_DETAIL_PAUSE_MIN_MS`/`CONVO_DETAIL_PAUSE_MAX_MS` defaults
  from `1500/3000` to an ε anti-phase-lock window (`0/150`).
- [x] 1.2 Update `CHATGPT_SERIAL_TUNING` and the frozen-default comments so the
  GCRA hint is the sole rate authority and jitter is ε noise only.
- [x] 1.3 Rewrite the existing "lane retains its 1500ms launch delay" test to
  assert the lane's launch wait is now governed by the pacing hint, with jitter
  bounded to ε.

## 2. Slow-start discovery + warm-start

- [x] 2.1 `ProviderPacing`: accept `restoredIntervalMs` (seed `_currentIntervalMs`,
  clamped to never be faster than `minIntervalMs`) and add `snapshot()`.
- [x] 2.2 `ProviderBudgetController`: re-expose `snapshotPacing()`.
- [x] 2.3 Lower the ChatGPT cold-start `initialIntervalMs` default from `2500` to
  `1000` (discovery seed, used only without fresh learned state).
- [x] 2.4 Connector: read the persisted learned interval from durable state at run
  start, apply the staleness guard, pass it as `restoredIntervalMs`.
- [x] 2.5 Connector: stamp the controller's final learned interval to durable state
  at the end of the detail pass.
- [x] 2.6 Tests: warm-start restores near the prior run's interval; a stale resume
  falls back to the cold seed; restore never crosses the ceiling.

## 3. The one owner number: the rate ceiling

- [x] 3.1 Confirm `PDPP_CHATGPT_PACING_MIN_INTERVAL_MS` is the single ceiling knob
  with a safe default; document it as the only number.
- [x] 3.2 Neutralize/annotate the concurrency-AIMD as inert under
  `maxConcurrency === 1` (no second control dimension).
- [x] 3.3 Test: additive increase floors at the ceiling and never crosses it.

## 4. Drain-within-budget recovery

- [x] 4.1 Make `recoverPendingMessageDetailGapsBeforeForwardRun` `void`-returning;
  remove the `return` on `stoppedWithPending` in `runConversationsAndMessagesStreams`.
- [x] 4.2 Continue to the forward walk; return only when `deps.runBudget?.shouldStop()`.
- [x] 4.3 Reconcile the `tailStop` abort: now a micro-optimization, not required.
- [x] 4.4 Test: a source-pressure recovery stop with remaining budget proceeds to
  the forward walk, advances the cursor, and keeps gaps durable; genuine budget
  exhaustion still defers.

## 5. Observability

- [x] 5.1 Emit a `collection_rate` structured progress event (current interval,
  effective rate, ceiling, last back-off + reason) on speed-up/back-off transitions.
- [x] 5.2 Add a "Collection rate" readout to the connection-detail diagnostics
  region, degrading to an explicit unknown.
- [x] 5.3 Test: the event carries no account content; the console readout degrades
  honestly when state is absent.

## 6. Simulation tests proving the ideal

- [x] 6.1 Under sustained success the effective interval DECREASES toward the
  ceiling over time (throughput rises) — the test that catches the flat-19/min posture.
- [x] 6.2 On injected 429/pressure the interval multiplicatively increases and recovers.
- [x] 6.3 The interval NEVER crosses the ceiling.
- [x] 6.4 Warm-start: a run resumes near the prior run's learned interval, not the cold default.
- [x] 6.5 Drain-within-budget: an open pressure circuit with remaining budget does
  NOT terminate; advances the cursor; defers gaps durably.

## 7. Gates

- [x] 7.1 Full chatgpt suite + governor/pacing/run-budget + reason-discrimination suites green.
- [x] 7.2 `tsc` + lint baselines.
- [x] 7.3 `openspec validate --all --strict` green.
- [ ] 7.4 Owner: supervised live calibration run (NOT done in this change).

## 8. In-pass circuit-continue (the in-pass analogue of §4)

Closes the live `run_1781150455121` defect: a `circuit_open` provider-budget gate
DURING a detail pass was bucketed with the genuine run caps
(`chatGptRunCapReasonFromProviderGate`), so a transient upstream-pressure circuit
deferred the entire remaining tail and finished the run after 136 s of a 900 s
budget. §4 fixed the recovery→forward-walk hand-off; this fixes the in-pass case.

- [x] 8.1 `CircuitBreaker.remainingCooldownMs()` + `ProviderBudgetController.circuitCooldownMs()`
  expose the exact open→half_open cool-down so a transient back-off can sleep it precisely.
- [x] 8.2 `RunBudget.remainingWallClockMs()` (+ `ChatGptRunBudget` delegate) bounds the
  cool-down wait by the run's true remaining wall-clock budget.
- [x] 8.3 `fetchConversationDetailWaitingOutCircuit`: on a `circuit_open` planned defer,
  wait the cool-down (bounded by remaining budget), then retry the same conversation;
  genuine budget exhaustion (`max_wall_clock`/`max_detail_fetches`) propagates immediately
  to the run-cap tail path. Forward-progress guard: a bounded cycle count + clock advance
  guarantees a never-closing circuit converges to a durable defer (no infinite loop).
- [x] 8.4 Tests: an open circuit with budget remaining CONTINUES (waits, resumes, collects
  the full tail); genuine wall-clock exhaustion during a wait still defers; a never-closing
  circuit is bounded; the live 136 s/900 s shape now runs the full budget. Src tests for the
  three new primitives. All green; `tsc` 0; biome clean.
