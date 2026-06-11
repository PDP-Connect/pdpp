# The SLVP-Ideal Whole-System Specification for Adaptive Personal-Data Collection

**Status:** Corpus — the durable normative answer. Synthesized from adversarially-surviving claims only; every claim below was re-checked against shipped source on 2026-06-11, then subjected to an external red-team (two independent passes) whose surviving attacks are folded in (§10).
**Owner:** the owner Nunamaker
**Created:** 2026-06-11
**Scope:** The complete, provider-agnostic specification for how PDPP collects any personal data source as fast as the provider safely allows, losing nothing, hands-off. It governs three layers that *compose* — (a) the in-connector collection-rate control loop, (b) the cross-run scheduler governance, (c) the user-facing honesty contract — because the live defects were all at the seams *between* these layers, not inside any one of them.

**How to read this.** This is one coherent system, not a menu. Each section states the invariant, names the one shipped surface that owns it, and (where a live defect exists) states the seam rule that makes the defect impossible by construction. Confidence is marked per section. The synthesis posture: the *architecture* is settled (~96%); two control-law refinements and one provider-generalization are open (~72–80%) and are isolated in §9 so the rest stands on its own.

**Red-team delta (§10).** The external red-team found a class of holes the rate-control synthesis missed entirely: the spec was complete on *short-horizon rate control* but **incomplete on long-horizon, unattended terminal states.** The §5 "monotonic convergence to 100%" claim is **false as written** — it assumes every gap is eventually fillable, which fails on permanently-deleted resources, poison gaps, and dead providers. The honesty contract's "never blocked for source pressure" rule can make `cooling_off` a *permanent lie* for a dead-but-429ing provider. And an unattended system has **no path to call for help**. §10 adds the terminal-state model and escalation path that close these; §5 and §6 are corrected accordingly. This is the single biggest correction and the reason the overall claim is **96%, not 99%** — stated honestly rather than asserted.

---

## 1. The Job (provider-agnostic essence + the three obligations)

**Confidence: 99%.** This is the Hickey-essence and it is not in dispute across any frame or attack.

> **Collect ANY personal data source as fast as the provider SAFELY allows, losing nothing, hands-off.**

The word "ANY" is load-bearing: the design MUST NOT be overfit to ChatGPT or to one owner's current data. ChatGPT is the proving-ground connector, not the specification's subject.

Three obligations, each independently testable, each owning a distinct layer of the system:

1. **Maximize throughput to safe saturation.** Run as fast as the provider tolerates — never slower out of timidity, never faster than safe. This obligation is discharged by the in-connector control loop (§2).
2. **Respond correctly when the safe rate is exceeded — no ban, no data loss.** When pressure appears, back off sharply, persist what could not be fetched, and never burn the account. This obligation is discharged jointly by the control loop's multiplicative back-off (§2), the lose-nothing substrate (§5), and cross-run governance (§4).
3. **Preserve everything not fetched this run.** Anything a bounded run could not complete becomes a durable, reason-discriminated re-entry point — not a faster probe, not a silent drop. This obligation is discharged by the lose-nothing substrate (§5) and converges to 100% across compounding runs.

A corollary the whole system serves: **after the initial browser authentication, the owner authors exactly one number and never has to ask again.** "Will it sync 100% of my data no matter how rate-limited I am?" has a permanent answer: *yes — across auto-resuming bounded runs, each one safe, converging monotonically to 100%, with zero owner action after auth.*

---

## 2. The Control Loop and THE ONE Authored Number

**Confidence: 96% on structure; 80% on two refinements isolated in §9.**

### 2.1 The loop

The in-connector rate loop is **AIMD probing an unobservable quota ceiling from below.** This is the theoretically-correct control law for this problem and the skeleton is right: for a single serial sender with no competing flows, the fairness dimension of AIMD vanishes and only its efficiency property — converge to a ceiling without destructive overshoot — is needed. The sawtooth IS the estimator, not a flaw.

The single controlled variable is the **inter-request interval** (`ProviderPacing._currentIntervalMs`, GCRA-paced; `packages/polyfill-connectors/src/provider-pacing.ts:85`). Interval (rate) is the correct control variable rather than window/concurrency: by Little's Law `window = rate × latency`, and for a single HTTP endpoint whose round-trip is dominated by ~constant server processing time, rate and window carry the same information, so rate control is simpler and a concurrency lane is a genuine no-op governor. `maxConcurrency = 1` is therefore a hard serial constraint, not a controller — the rate/concurrency plane collapses to a line and the concurrency-AIMD machinery is inert (see §7).

The loop, as one closed cycle:

> The single pre-flight gate waits `max(launchDelay, cooldown, pacingDelayHint())` — **never a sum** (`adaptive-lane.ts:466`). `pacingDelayHint()` is the GCRA interval the rate-AIMD currently owes (`ProviderPacing.nextDelayMs`, provider-pacing.ts:123). The request fires through the *separate* retry layer. On clean success → `recordSuccess()` shaves the interval toward the floor (provider-pacing.ts:167). On a throttle signal (429) → `recordThrottle()` multiplies the interval up (provider-pacing.ts:175) and, if the request already slept its own Retry-After, the double-pay guard skips re-adding that wait. If pressure or budget trips, the unfetched tail becomes durable reason-discriminated gaps (§5) and the run exits. One variable, one signal, one wait, one loop.

### 2.2 THE ONE authored number

There is **exactly one** hand-set behavioral-safety prior in the entire system: the **rate ceiling**, `minIntervalMs` — the fastest interval AIMD is permitted to reach. Shipped as `DEFAULT_PACING_MIN_INTERVAL_MS = 250` (connector-http-governor.ts:167), surfaced for ChatGPT as `CHATGPT_DEFAULT_PACING_MIN_INTERVAL_MS = 250` (chatgpt/index.ts:329).

Every other constant is *derived from this one*, or is an AIMD *shape*, or is an opt-in operational envelope — never a second safety prior:

- The interval *floor* the loop converges toward = this number. There is no separate floor.
- Run termination in the default configuration is **structural** (work drained → stop) or **provider-signaled** (density stop on real 429s), never clock-driven. A correctly-bounded AIMD over a finite work queue with a durable-gap substrate completes without a timer.
- The wall-clock and detail-fetch caps (`RunBudget`) default to `Infinity` / off and are *not* safety numbers — they are opt-in unattended-scheduling envelopes (§7).

**Why this is the only number:** the quota ceiling is *behavioral, not technical* — cumulative, stateful, account-specific, and **cannot be discovered by probing without risking the account.** The operator sets the rate ceiling *below the estimated behavioral flagging threshold* (not merely below the observed 429 threshold), inductively from healthy-session behavior. This is the one place the system must be a fixed prior rather than adaptive. Its *value* is owner's-call and excluded from any confidence claim.

### 2.3 The signal and the retry seam (both essential, both correct)

- **429 is the definitive multiplicative-decrease trigger** and must stay. It is the only reliable saturation signal for a quota-enforced API.
- **Retry and rate-control are correctly separated** (the theory-correct split, mirroring TCP's separation of retransmission from congestion control). `retryHttp` owns retransmission/backoff and honors Retry-After; pacing owns the inter-request rate. They interact *only* through the congestion signal: `onRetry` feeds `recordThrottle` a multiplicative decrease but deliberately does **not** forward Retry-After into the pacing bucket, because `retryHttp` already slept it (`connector-http-governor.ts:236`; double-pay guard via `absorbedByRequestWait`/`retryAfterAlreadySlept`, chatgpt/index.ts:2814). Keep this seam exactly as-is.

---

## 3. The Provider-Profile Interface (what makes the loop source-agnostic)

**Confidence: 72%.** The *need* for this interface is high-confidence (it is the structural antidote to ChatGPT-overfit); the exact field set is a synthesis recommendation pending a per-connector audit (§9).

The control loop above is correct but is currently parameterized by constants that silently encode *ChatGPT's* measured behavior and are inherited by six other connectors by omission. The provider-agnostic fix is to lift every provider-specific quantity out of shared defaults and into a required `ProviderProfile` that each connector author must declare from *their own* provider's observed behavior. **No shared default for a safety- or pressure-shaped quantity** — a missing field is a build error, not a silent borrow of ChatGPT's number.

The fields that make the loop source-agnostic:

| Field | Replaces (today's overfit) | Why it must be per-provider |
|---|---|---|
| `safetyCeiling` (min interval, ms) | `DEFAULT_PACING_MIN_INTERVAL_MS = 250` as a *shared* default (connector-http-governor.ts:167) | THE one authored number. ChatGPT's account-tuned 250ms is meaningless for a provider that sends Retry-After or rate-limits by slowdown. Required, no default. |
| `recoveryCurve` (`additiveIncreaseMs`, `multiplicativeDecreaseFactor`) | frozen `100` / `0.5` (provider-pacing.ts:97-98), unreachable through the shared factory | The AIMD shape is provider-specific; the recovery curve must be surfaced through `ConnectorHttpGovernorOptions`. |
| `pressureSignal` (429 semantics: is a bare 429 "whole-account-hot"? fast-open attempts?) | `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS=3` + "bare 429 = whole-account-hot" interpretation, localized in chatgpt/index.ts | Each provider's 429 means something different; the next connector must declare its own, not copy ChatGPT's. |
| `servedBackoffCostMs` (tolerated cumulative honored backoff, expressed in ms) | density stop `CHATGPT_RATE_LIMIT_DENSITY_STOP_DEFAULT = 8` (chatgpt/index.ts:205) — a count standing in for a real quantity | "8" is meaningless off ChatGPT's measured ~30–50s/429. The mechanism is essential; express the budget as ms and divide by the profile's per-429 cost. |
| `quotaUnit` (`request` \| `token`) | implicit request-weighting | If a provider's binding quota is TPM and payloads vary widely, request-rate AIMD oscillates. Profile declares the axis; loop weights consumed units accordingly. Open (§9). |
| `interactionPosture` / `concurrency: 1 fixed` | implicit connector-class assumption | Makes "this provider is rate-controlled, concurrency fixed at 1" an explicit declaration, so a future latency-probeable API connector is not forced into the browser-consumer mold. |

The loop's *structure* (one rate variable, AIMD, 429-driven MD, separate retry, hard ceiling) is fixed and identical for every provider. The *profile* is the only thing that varies. This is what discharges obligation (1)'s "ANY source" without re-deriving the controller per connector.

---

## 4. Cross-Run Governance: the CORRECT Eligibility Predicate

**Confidence: 95% on the defect and the predicate split; ~75% on the exact API shape (§9).**

This is the seam where the live system is *broken*, and the section the owner most needs as a durable answer. Two cross-run governors are correct and must both exist; the bug is a single composition predicate that conflates them.

### 4.1 The two governors are essential and must stay separate

- **Governor A — source-pressure cooldown** (`reference-implementation/runtime/scheduler-source-pressure-cooldown.ts`): reacts to `upstream_pressure`/`rate_limited` gaps; grows `2^min(attempt,6)` (L216-217), caps at 6h (L80), **always recommends `cooling_off`, never `blocked`** (L242), relaxes the moment the pending pressure set empties. This is the SLVP-ideal cross-run analogue of multiplicative decrease and the most provider-agnostic governor in the system. Only the 6h *cap value* is a provider recovery-curve parameter; the mechanism stays.
- **Governor B — failure back-off ladder** (`scheduler-backoff.ts`): counts *failed* runs, escalates an exponential ladder toward `blocked`/`gave_up`, caps at 24h.

They react to **disjoint, simultaneously-possible** conditions: a run can `succeed`-with-deferred-pressure (Governor A, zero failure streak) *and* be in a failure streak (Governor B) at once. Merging them would conflate "provider hot, will recover" with "connector broken" — a correctness *and* honesty regression. Keep them as separate pure modules.

### 4.2 The defect: a single binary gate causes head-of-line blocking

The live eligibility predicate is:

```
eligible = elapsed >= decision.effectiveIntervalMs && !cooldownDefers   // scheduler.ts:1833
```

This couples **congested work** (forward-walk fetches into the hot bucket) and **non-congested work** (recovery of `run_cap_deferred` / `retry_exhausted` gaps that are NOT source pressure) into one queue gated by a single boolean. One source-pressure cooldown — armed by a handful of `upstream_pressure` gaps — therefore suppresses the *whole dispatch*, including recovery of hundreds of non-pressure gaps that have no claim on the cooldown. This is the classic head-of-line-blocking anti-pattern and the live 942-gap starvation: a small set of pressure gaps holds a large set of recoverable gaps hostage, so coverage can never reach 100% while any single pressure gap keeps re-arming the cooldown every tick (a positive-feedback loop with no negative feedback to break it — the act of cooling prevents the recovery that would clear the condition).

A congestion controller MUST stay **work-conserving for the non-congested sub-flow.** The single gate violates this.

### 4.3 The CORRECT predicate: split forward from recovery

The predicate splits into two, discriminated by gap reason — making cooldown-starves-recovery impossible by construction:

```
eligible_forward  = elapsed >= effectiveIntervalMs && !cooldownDefers
eligible_recovery = (pending non-source-pressure gaps exist)            // cooldown has NO claim here
```

- `eligible_forward` keeps today's predicate verbatim (scheduler.ts:1833) and keeps the `max-of-two-governors` composition (wait the longer of failure-backoff and pressure-cooldown before re-probing the hot bucket). This is correct and stays.
- `eligible_recovery` is **reason-gated and cooldown-exempt.** The source-pressure cooldown defers only NEW forward-walk fetches; it MUST NOT block the drain of already-deferred non-pressure work. The gap-reason discrimination already exists and is correct — `SOURCE_PRESSURE_GAP_REASONS = {rate_limited, upstream_pressure}` (cooldown.ts:53); `run_cap_deferred`/`retry_exhausted` are deliberately excluded so they never arm the cooldown. The bug is that the *consumption* at scheduler.ts:1833 ignores this discrimination and gates everything. The fix threads a **recovery-only launch mode** so the connector's existing recovery-before-forward-walk pass (`recoverPendingMessageDetailGapsBeforeForwardRun`, chatgpt/index.ts:3163, called L3230) can run while the forward walk is suppressed.

### 4.4 The mandatory sequencing guard

When recovery-only dispatch runs under an active cooldown, the recovery lane **MUST NOT trigger the forward walk or new list-phase fetches** into the hot bucket — otherwise it re-pressures the exact source the cooldown protects. The fix gates the forward-walk *phase*, not merely the dispatch. The recovery lane's own detail fetches MUST ride the same intra-run pacing/circuit (ProviderPacing/adaptive-lane), so a recovery-only run still backs off on 429 and re-defers — it is not a raw-fetch bypass. This is the seam rule that makes "drain the backlog under cooldown" safe rather than a re-pressuring treadmill.

---

## 5. The Lose-Nothing Substrate

**Confidence: 98%.** Sound in isolation; the only defect was the drain *trigger* (§4), never the substrate.

The literal discharge of obligation (3) is the durable **`DETAIL_GAP`** record. When a run stops early for any reason, the unfetched tail becomes durable gap records keyed for re-entry. The substrate has one essential property beyond durability: **reason discrimination.**

- `upstream_pressure` / `rate_limited` → source-pressure class → arms Governor A's cooldown.
- `run_cap_deferred` → voluntary-cap class → does NOT arm the cooldown (a capped run is not a hot provider).
- The reason code is the *single source of truth* that lets cross-run governance (§4) and UI honesty (§6) discriminate "provider is hot" from "we chose to stop." Without it, capped runs would inject false inter-run delays and the dashboard would mislabel a self-healing connection as broken.

Convergence to 100% is produced by this substrate plus scheduler cadence, regardless of caps — **but only over the set of FILLABLE gaps** (corrected by red-team, §10). Each run (a) recovers prior *fillable* gaps first (`DETAIL_GAP_RECOVERED` per hydrated key), (b) commits its cursor only over the hydrated prefix, (c) writes new gaps for whatever it deferred. The fillable backlog converges **monotonically** to zero. The wall-clock cap, if ever set, only makes an individual run stop earlier and defer more to the next run — it never changes the terminal 100%. That is the definition of incidental.

**Correction (§10-A).** The original "converges monotonically to zero" was false as written: it silently assumed every gap is eventually fillable. A permanently-deleted resource (404/410), a poison gap (persistent 500 on one key), or a dead endpoint produces a gap that *never* hydrates, so a naïve `pending` count never reaches zero and a recover-first scheduler can let one poison gap starve all forward progress. The substrate therefore requires a **terminal gap class** (§10): a gap that exhausts a bounded recovery-attempt budget against a *non-transient* error (404/410/permanent-403, or N identical 500s) transitions to `terminal` — removed from the *fillable* pending set that drives convergence and the cooldown, but **counted separately and surfaced**, never silently dropped. With this, the corrected guarantee holds: *the fillable backlog converges monotonically to zero; the terminal set is bounded, visible, and escalated.*

The circuit breaker (`CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES = 8`, chatgpt/index.ts:353) is the correct pathology instrument for a *slow-hostile* provider: a circuit that keeps re-opening converges to a durable defer after a bounded number of cool-down waits instead of looping forever — the principled bound a wall-clock cap only coarsely approximates (and which fires destructively on healthy-slow runs).

---

## 6. The Honest UI Contract

**Confidence: 95% on the state machine and invariants; the live render contradiction is code-confirmed below.**

The obligation here is an honest user-facing contract: the owner reads **one** authoritative answer to "is this OK?" and that answer never contradicts itself.

### 6.1 The health-state machine (single-valued, one state at a time)

A single authoritative verdict is the irreducible honesty primitive. The projected state is **single-valued** — exactly one of the states below at any moment. The contradiction is *never* in this layer; it is manufactured downstream when a second projection or a render-time boolean disagrees with it.

The exact per-state condition (synthesized from `synthesizeConnectionVerdict`, connection-evidence.ts:1106):

| State | Exact condition | Handling itself? | Owner CTA |
|---|---|---|---|
| `healthy` / `idle` | work drained, fresh, no pending gaps | yes | none |
| `cooling_off` | **source-pressure cooldown**: `reason_code == source_pressure` OR (pending source-pressure backlog AND a scheduled `next_attempt_at`) — see `isSourcePressureCooldown`, connection-evidence.ts:1094 | **yes** — self-resolving | **none** ("resumes automatically") |
| `cooling_off` (failure) | scheduler back-off after failed runs, no source pressure | yes | wait |
| `degraded` | ran, but coverage/freshness incomplete; retryable gap → an ordinary run fills it | yes if retryable | view runs |
| `needs_attention` | owner action required before progress (e.g. credential capture) | no | reconnect |
| `blocked` | **stopped making progress, retries paused, NOT source pressure** — genuinely expired credentials / blocked session | no | reconnect |

The decisive rule: **a rate-limited-but-succeeded connection renders `cooling_off`, never `blocked`.** Source pressure is expected to recover; it is not a terminal stop and must never carry a Reconnect CTA.

### 6.2 The no-contradiction invariant

> **No surface may render `blocked` (or a Reconnect CTA) while the live state is a source-pressure cooldown, and no surface may render `blocked` simultaneously with `in_progress` or `succeeded`/`succeeded_with_gaps`.**

The live violation is a *second, divergent projection*. `synthesizeConnectionVerdict` correctly suppresses `blocked` for source pressure (connection-evidence.ts:1113-1124, via the `isSourcePressureCooldown` guard at L1094). But its twin, `deriveFailureSummary`, re-implements `state → copy` and its `blocked` branch has **no source-pressure guard** — it emits `cta: "reconnect"` and "credentials expired / blocked session" prose unconditionally (connection-evidence.ts:1625-1635). Note its *own* `cooling_off` branch (L1612-1623) *does* discriminate source pressure — proving the omission in the `blocked` branch is an oversight, not a design choice. Combined with `overview.isRunning` computed independently at render time, this manufactures the live "`blocked` + `in_progress` + `succeeded_with_gaps`" contradiction.

The fix is **not** to remove `synthesizeConnectionVerdict`'s guard — that is the correct half of the machine. The fix is to make EVERY surface derive from the same effective verdict:

- `deriveFailureSummary` MUST derive from the same synthesized verdict, not re-compute state→copy. Its `blocked` branch must apply the same `isSourcePressureCooldown` suppression. (This is a behavioral change pinned by a test that feeds only `{state:'blocked'}` with no `reason_code`; closing the split requires *adding* a source-pressure-blocked test, an intended change, not a silent refactor — see §9.)
- `overview.isRunning` MUST feed the single verdict, not sit beside it.
- Per-run `StatusBadge` in the runs *list* (rendering raw `succeeded_with_gaps`) is fine and truthful **in context** — it is history, not the headline. It only reads as contradictory when the headline above it is wrong; fix the headline and the list badge is harmless. The raw `reason_code` shown on the *detail* page beside the badge is also correct — the detail page is the right place to expose the underlying evidence token; it does not pollute the headline.

### 6.3 The meaning of "100% / done"

"100%" means **`detail_gap_backlog.pending === 0`**, and it is only trustworthy under conditions any "Done" affordance MUST gate on jointly (corrected for terminal gaps per §10):

```
done  ⟺  pending === 0  AND  backlog !== null  AND  !pending_is_floor  AND  terminal === 0
fully_recovered_with_caveats  ⟺  pending === 0  AND  backlog !== null  AND  !pending_is_floor  AND  terminal > 0
```

- `backlog === null` means *unmeasured* — the console correctly stays silent, it does not claim done.
- `pending_is_floor` means the count is a lower bound, not exact — "done" would be a lie.
- `terminal > 0` means some work is permanently unfillable (deleted/poison/gone). The honest verdict is **not** a bare "100% done" — it is *"recovered everything still available; N items are no longer retrievable at the source"* with the terminal set visible. Folding `terminal` into `done` (by dropping terminal gaps out of `pending`) would make the UI claim 100% while data is missing — the exact silent-lie the red-team surfaced (§10-A).

A truthful "100%" is reached by compounding bounded runs draining the gap substrate to zero, **not** by any wall-clock or fetch cap. The honest copy the owner sees is: *"converges to 100% across auto-resuming runs; captured progress is always safe; no action needed."* **Caveat (§9):** this copy is only honest once the §4 seam is fixed — while the cooldown starves recovery, "it resumes on its own" is false for the stranded non-pressure backlog.

---

## 7. Essential vs Incidental — every surface

**Confidence: 95%** (each verdict traces to an obligation or a named defect).

| Surface (file:line) | Verdict | One-line rationale |
|---|---|---|
| AIMD update law — probe ceiling from below, MD on congestion | **essential** | Proven-correct estimator for an unobservable ceiling; the sawtooth is the mechanism, not a flaw. |
| Interval as control variable / `maxConcurrency=1` (adaptive-lane) | **essential** | Constant-latency single endpoint → rate ≡ window; concurrency lane is a true no-op governor. |
| THE rate ceiling `minIntervalMs=250` (connector-http-governor.ts:167) | **essential** | The ONE authored behavioral-safety prior; undiscoverable by probing, never crossed. |
| 429 as the MD trigger | **essential** | The only reliable saturation signal for a quota-enforced API. |
| Separate retry layer + Retry-After NOT re-fed into pacing (connector-http-governor.ts:236) | **essential** | Theory-correct retransmission/congestion split; the double-pay guard is the right seam. |
| Durable `DETAIL_GAP`, reason-discriminated | **essential** | The literal lose-nothing guarantee + the discriminator the whole system depends on. |
| Source-pressure cooldown *mechanism* (cooldown.ts, 6h cap, `2^attempt`, never-blocked, reads only pressure reasons) | **essential** | Most source-agnostic governor; the cross-run analogue of MD; relaxes on recovery. |
| Failure-backoff ladder (scheduler-backoff.ts, exponential off baseInterval) | **essential** | Provider-agnostic chronic-failure governor; correctly NOT firing on succeeded-with-pressure. |
| Two governors as separate modules | **essential** | React to disjoint simultaneous conditions; merging conflates "hot" with "broken." |
| Density stop *mechanism* (chatgpt/index.ts:205) | **essential** | Cumulative-across-conversations pressure detector the per-conversation circuit cannot see. |
| Circuit breaker wait-out (chatgpt/index.ts:353) | **essential** | Principled bound for the slow-hostile pathology; the correct instrument vs a wall-clock cap. |
| Warm-start persisted interval + staleness guard (provider-pacing.ts:101-110, restore clamped to ceiling) | **essential** | Cached-ssthresh analogue; compounds AIMD descent across the scheduled cadence. |
| `synthesizeConnectionVerdict` source-pressure suppression of `blocked` (connection-evidence.ts:1094-1124) | **essential** | The correct half of the honesty machine; the fix is to make every surface use it. |
| Single-valued projected state (one state at a time) | **essential** | The irreducible honesty primitive; contradiction is never in this layer. |
| Additive-decrease in INTERVAL space (provider-pacing.ts:168) | **essential-but-misplaced** | Probing up is essential; constant-Δms in interval-space is the wrong space — accelerates super-linearly near the ceiling (§9-C2). |
| 429 as the ONLY congestion signal | **essential-but-misplaced** | 429 must stay; relying on it *alone* forces learning the ceiling by hitting it — maximally ban-risky. Missing delay/challenge pre-signal (§9-C4). |
| State-dependent β from the `initialIntervalMs` clamp (provider-pacing.ts:185) | **essential-but-misplaced** | MD direction correct; clamp makes β state-dependent (0.25 from a warm interval, →1 from a slow one), breaking AIMD's fixed-β convergence proof (§9-C3). |
| Shared `DEFAULT_PACING_MIN_INTERVAL_MS`/`additiveIncrease`/`MD` defaults inherited by 6 connectors | **essential-but-misplaced** | A per-provider ceiling is essential; shipping ChatGPT's value as the cross-provider default is the core overfit → `ProviderProfile` (§3). |
| Single binary eligibility gate (scheduler.ts:1833) | **incidental** | Couples congested + non-congested work → head-of-line blocking / 942-gap starvation. Split into forward/recovery (§4). |
| `deriveFailureSummary` `blocked` branch, no source-pressure guard (connection-evidence.ts:1625-1635) | **incidental** | A second divergent projection emitting a false Reconnect CTA for a self-healing cooldown. Derive from the single verdict (§6). |
| `overview.isRunning` composed at render time, no reconciliation | **incidental** | Manufactures `blocked`+`in_progress`. Must feed the single verdict. |
| Wall-clock cap / fetch cap (`RunBudget`, default `Infinity`) | **incidental** | Opt-in unattended envelope, not a safety invariant; fires on healthy-slow runs. Only its reason-discrimination (run_cap_deferred) is essential — and that lives in the gap reason set, not the cap. |
| Concurrency-AIMD (`maybeIncrease/decreaseConcurrency`, adaptive-lane) | **incidental** | Dead code under `maxConcurrency=1`; the rate/concurrency plane collapses to a line. |
| `tailStop` AbortController self-terminating recovery exit | **incidental** | Existed only because a fixed launch-jitter floor made tail-iteration cost minutes; the floor is already deleted, so it is now a micro-optimization. |
| `createConnectorHttpGovernor` vs `ProviderBudgetController` (two factories) | **incidental** | Structural duplication (API vs browser connectors); maintainability redundancy, not a behavioral defect. |
| Density-stop *count* `=8` (chatgpt/index.ts:205) | **incidental** | A count standing in for ChatGPT's measured per-429 cost; express as a ms backoff-budget ÷ profile cost (§3). |
| Per-run badge in runs LIST / raw `reason_code` on detail page | **incidental** | Truthful in context (history / evidence token); only reads wrong when the headline is wrong. |

**Stale-grounding correction (verified in source 2026-06-11):** the legacy launch-jitter floor `CONVO_DETAIL_PAUSE_MIN_MS=1500/MAX=3000` that prior docs called "the single biggest delete" is **already deleted** — it is now `0`/`150` (chatgpt/index.ts:1965-1966), pure pattern-avoidance jitter, with the GCRA rate-AIMD as the binding governor. Any plan premised on deleting it is fixing a closed issue.

---

## 8. Composition Rules That Make Seam-Bugs Impossible By Construction

**Confidence: 95%.** These are the load-bearing rules; the live bugs were *all* violations of one of them.

1. **One wait, never a sum.** The pre-flight gate is `max(launchDelay, cooldown, pacingDelayHint())` (adaptive-lane.ts:466) — never additive. Summing waits double-pays backoff and amplifies the very signal that caused the slow-down. *(Already satisfied; the historical dual-wait stacking is gone.)*

2. **The congestion signal crosses layer boundaries; the time-budget never does.** Retry and pacing interact *only* through the signal (429 → `recordThrottle`); Retry-After is honored in exactly one layer (retryHttp) and never re-fed into pacing. Guard: `absorbedByRequestWait`/`retryAfterAlreadySlept`. This makes double-pay structurally impossible.

3. **Discriminate work by gap reason at every governance and display seam — never by a single binary gate.** Source-pressure gaps and voluntary-cap/recovery gaps are different sub-flows. Any predicate that gates "the whole dispatch" or "the whole headline" on one of them is a head-of-line-blocking bug (§4) or an honesty bug (§6). The rule: *cooldown defers only the congested sub-flow (forward walk); recovery of non-pressure work is work-conserving and cooldown-exempt.* This makes cooldown-starves-recovery impossible by construction.

4. **One verdict, many readers; never many verdicts.** There is exactly one health-state synthesis (`synthesizeConnectionVerdict`). Every surface — failure summary, overview headline, in-flight indicator — *derives from it*, never re-computes state→copy. A second projection with its own state logic is a divergent source of truth and the root of every visible contradiction. This makes "blocked + cooling_off" and "blocked + in_progress" impossible by construction.

5. **Recovery rides the same governor as forward fetches.** Any path that issues detail fetches — including the recovery-only lane — goes through ProviderPacing/adaptive-lane so it backs off on 429 and re-defers. No raw-fetch bypass. This makes "draining the backlog re-pressures the source" impossible by construction.

6. **Every provider-specific quantity is a declared `ProviderProfile` field with no shared default.** A safety- or pressure-shaped constant with a cross-provider default is overfit waiting to happen. Forcing declaration makes "connector silently inherits ChatGPT's account-tuned number" impossible by construction (§3).

7. **The safety ceiling is a fixed prior, set below the behavioral threshold, never probed.** The one number the system does not adapt. Every other constant is derived, a shape, or an opt-in envelope. This makes "the controller discovers the ban threshold by hitting it" impossible by construction.

---

## 9. Residual Uncertainty — what is NOT yet certain, and how to close it

**Confidence: this section is the honest boundary of the 99% claim.** The *architecture* (§1, §2.1, §5, §6.1, §8) is ≥96%. What follows is below 95% and must be closed before the corresponding change ships.

**C1 — Provenance of the stranded non-pressure backlog (the 942/964 `retry_exhausted`, attempt-0 gaps).** `retry_exhausted` is emitted by the `run_cap_deferred` path, yet the live container has caps OFF. Either (a) a prior run with a cap set, or (b) an unidentified second emitter. *Close it:* grep for `buildDetailGap` with `reason:'retry_exhausted'` outside the two known run-cap builders; confirm against live `spine_events` before shipping the §4 recovery drain. If (a), the drain runs once and is done; if (b), the drain is a treadmill until the emitter is fixed. Confidence the §4 *structural* fix is correct regardless of provenance: high; confidence the backlog is fully explained: 0.82.

**C2 — Interval-space additive-increase is not true AIMD.** `recordSuccess` subtracts a fixed 100ms from the *interval* (provider-pacing.ts:168), but AIMD prescribes additive increase of *rate*. Because `rate = 60000/interval` is convex, constant -Δms interval steps make rate climb super-linearly as interval nears the floor — the probe accelerates fastest exactly where it is riskiest. *Close it:* run the controller in rate-space (or decrement interval by a rate-proportional amount), gated on a closed-loop sim or A/B — the live ChatGPT calibration may make the divergence behaviorally moot. **Do not rewrite without first grepping `provider-pacing` tests** for a pin on the 100ms-decrement shape. Confidence the math diverges from textbook AIMD: high; confidence it is *behaviorally* harmful: unmeasured.

**C3 — State-dependent β from the `initialIntervalMs` clamp.** `recordThrottle` clamps to `Math.max(initialIntervalMs, interval/0.5)` (provider-pacing.ts:185): from a warm 250ms interval one throttle jumps to 1000ms (effective β=0.25); from a slow interval the ×2 is capped at the seed (β→1, no back-off). AIMD's convergence proof needs a fixed β. *Close it:* same sim/A-B and test-pin check as C2.

**C4 — Missing delay / behavioral-challenge pre-signal.** A rising response-time vs a rolling baseline (Vegas/BBR) is a free, ban-risk-free early congestion signal that arrives *before* the 429 — and the cost asymmetry here (a 429 risks the account) is far worse than in TCP. But adding it assumes latency actually rises under this provider's soft-throttle. The 2026-06-02 ChatGPT A/B found *bare* 429s; it did NOT establish whether p50 latency rises first. Through the neko browser path, end-to-end wall time is confounded by DOM/JS/CPU/screenshot latency and may be too noisy. *Close it:* measure p50-latency-vs-baseline on a live pressured account before building; ship Reno-style (429-primary, latency advisory-off) until measured. Also unaddressed: content-level soft-bans/challenges (CAPTCHA, re-auth, empty-where-non-empty) — route to the session-health layer, but the hook was not found in the shared API governor (it may live in per-connector browser code; unaudited).

**C5 — Single-provider validation.** The entire analysis is validated against ChatGPT only. A provider that sends Retry-After, rate-limits by slowdown rather than 429, benefits from concurrency>1, or is TPM-bound would shift §2–§3 verdicts. The §3 `ProviderProfile` is the structural antidote but its field set is unaudited against the other six governor-using connectors (github/ynab/notion/strava/oura/spotify). *Close it:* per-connector audit of real 429 semantics and binding-quota axis. Confidence the interface *shape* is right: 0.72.

**C6 — Token-weighting (RPM vs TPM).** The loop measures request-rate. If ChatGPT's (or any connector's) binding quota is TPM and payloads vary ~1000×, the controller oscillates on payload-mix shifts, and a shared 250ms request-interval ceiling is wrong in a way no env override fixes. Whether consumer-account 429s name their axis (`model_request_limit` vs `model_token_limit`) is uncharacterized. *Close it:* characterize the 429 body; add `quotaUnit` to the profile (§3).

**C7 — UI fix is a pinned behavioral change, and the honesty copy currently overpromises.** `deriveFailureSummary` is locked by a test feeding only `{state:'blocked'}` with no `reason_code`; fixing the §6 split requires *adding* a source-pressure-blocked test and changing the function — an intended behavioral change, not a silent refactor. Separately: the "it resumes on its own" copy is **false** for the stranded non-pressure backlog until the §4 seam is fixed — the UI contract cannot be fully honest until cross-run governance is. No invariant test yet forbids simultaneous `blocked` + `in_progress`/`succeeded`; adding it requires a behavioral test in `connection-evidence.test.ts` plus a source-regex guard in `page-health-surfaces.invariants.test.ts`. *Close it:* land §4 and §6 together; the honesty claim depends on the governance fix.

**C8 — The recovery-only API shape and run-record semantics.** The *direction* of the §4 fix (split forward vs recovery eligibility; drain non-pressure gaps under cooldown; recovery rides the governor) is high-confidence. The precise API (two booleans vs a launch-mode enum; where the flag threads) is inferred from the call graph, not read from an existing spec (0.72–0.78). Also undecided: whether a recovery-only tick is a NEW run record or reuses the existing run with a suppressed forward walk — which affects whether the 14-day streak strip and headline read truthfully (a recovery tick must not render as a full sync). *Close it:* a failing test that launches a tick with pending `retry_exhausted` gaps under an armed source-pressure cooldown and asserts the gaps drain — it does not yet exist and would lock the fix.

**C9 — `isSourcePressureCooldown` guard precision.** It infers cooldown from (pending backlog + `next_attempt_at`) when `reason_code` is absent (connection-evidence.ts:1098-1103). If the reference ever emits a genuinely `blocked` connection that still carries a stale `next_attempt_at` + backlog, this guard wrongly suppresses a real reconnect prompt. *Close it:* verify the backend projection never leaves those fields set on a terminal block.

**C10 — Live numbers are prior-analysis, not re-measured this session.** The 942 `retry_exhausted` / 51 `upstream_pressure` / persistence 16→2 figures are from the 2026-06-11 ~14:40Z diagnosis snapshot, not a fresh probe. The class-level defect and the predicate fix are code-grounded (scheduler.ts:1833, verified) and hold regardless of exact counts; treat the counts as illustrative, not load-bearing.

---

## 10. The Terminal-State Model and Unattended Escalation (red-team delta)

**Confidence: 90% on the model; it is NEW and unshipped, so it carries more open design than §1–§8.**

Two independent external red-team passes converged on one class of hole the rate-control synthesis missed: the spec was complete on **short-horizon rate control** and incomplete on **long-horizon, unattended terminal states.** Over days–weeks with an owner who is *not* watching a dashboard, the following break — and the fixes below close them. Each attack is tagged with the obligation it violates.

### 10-A. Terminal (unfillable) work — fixes the false convergence claim. [O3 + honesty]

A gap can be permanently unfillable: a **deleted resource** (404/410), a **poison gap** (persistent 500 on one key), or a **dead endpoint**. The original §5 "monotonic convergence to zero" assumed this away. Three concrete failures:
- *Never-converges:* a 404 gap keeps `pending ≥ 1` forever; the system is "working" but never done.
- *Poison-gap stall:* recover-first means one persistently-500 gap is retried first every run, starving ALL forward progress — a silent total stall.
- *Silent-100%-lie:* if a terminal gap is simply dropped from `pending` to make convergence "work," the UI claims 100% while data is missing.

**The fix — a `terminal` gap class (this is the missing reason-discrimination at the substrate):**
- A gap that exhausts a **bounded recovery-attempt budget** (`maxRecoveryAttempts`, a `ProviderProfile` field) against a **non-transient error** (404/410, permanent 403, or N identical 5xx) transitions `pending → terminal`.
- `terminal` gaps are **removed from the fillable pending set** that drives convergence AND the cooldown (so they cannot starve recovery or re-arm cooldown), but are **counted and surfaced separately** — never silently dropped.
- Convergence claim, corrected: *the fillable backlog converges monotonically to zero; the terminal set is bounded, visible, and escalated.*
- `done ⟺ pending===0 AND backlog!==null AND !pending_is_floor AND terminal===0`; with `terminal>0` the honest verdict is "recovered everything still available; N items no longer retrievable at the source" (§6.3).

### 10-B. The "cooling_off forever" lie — fixes the honesty rule's blind spot. [O3 + honesty]

The rule "source pressure is *never* `blocked`" (§6.1) is correct for a *recovering* provider but becomes a **permanent lie** for a *dead-but-429ing* provider (decommissioned endpoint returning 503/429, or a week-long outage). The system cools 6h, retries, re-fails, forever — and the UI says "cooling_off / resumes automatically," which implies transient when it is terminal.

**The fix — a persistence ceiling on cooldown, distinct from the cap on its *delay*:**
- Governor A's 6h *delay* cap stays. ADD a **consecutive-cooldown-cycles ceiling** (`maxCooldownCycles`, profile field): after K cycles with **zero forward progress and zero gap recovery**, the connection escalates from `cooling_off` → `needs_attention` ("this source has been unreachable for T; it may be down or your access may need renewal"). This is NOT the failure-backoff ladder (Governor B) — it is a *no-progress* escalation that catches the case both governors miss (succeeded-with-pressure that never actually advances). Closes the dead-zone the v2 red-team also found (a circuit-trip-from-pressure run arms neither governor).

### 10-C. Credential expiry mid-horizon — the missing non-transient auth class. [O3 + honesty]

A token expires on day 31; every call returns 401. This is neither source-pressure (must not cool) nor a generic retryable gap (must not spin forever). **The fix:** 401/permanent-403 is a **distinct non-transient class** that immediately routes to `needs_attention` with a reconnect CTA — never a gap, never a cooldown. (Partly shipped via credential-capture states; the spec makes it normative that auth failure is its own class, not folded into pressure or generic failure.)

### 10-D. Pacer-state pollution by cooldown-exempt recovery. [O2 — ban risk]

The §4 recovery-only lane "rides the same pacer." But a recovery run's **successes additive-decrease the shared interval** — so a cooldown-exempt recovery run *speeds the pacer back up*, un-learning the back-off the cooldown is protecting; the next forward run then bursts at a rate the provider just proved it can't take. The §4.4 "rides the same governor" guard only covers *back-off on 429*, not *speed-up on success*.

**The fix — recovery may decelerate the pacer, never accelerate it:** while a source-pressure cooldown is active, the recovery lane's `recordSuccess` is **suppressed from additive-decrease** (it still records throttles → multiplicative-increase). Recovery rides the learned interval read-mostly: it can be slowed by pressure, never speed the shared pacer toward the ceiling during a cooldown. This makes "recovery un-learns the back-off and re-pressures" impossible by construction (a new §8 rule, below).

### 10-E. Stale warm-start + recovery exemption = burst into a tightened quota. [O2 — ban risk]

Warm-start restores a learned-aggressive interval; if the provider tightened during a long idle, the first request bursts too fast — and the recovery lane is cooldown-*exempt*, so it bypasses the one governor that would have slowed the re-approach. **The fix:** if `idle > maxCooldownDelay` (or warm-start is stale), the **first request of ANY lane (including recovery) re-enters at the conservative cold-start interval**, not the restored one. Warm-start accelerates a *continuing* descent; it must not grant a *cold* burst. (Sharpens §9-C and the §2.3 staleness guard.)

### 10-F. The meta-failure — no path to call for help. [the unattended premise itself]

The umbrella finding: an autonomous system that walks away for weeks **must be able to summon the owner** when it exhausts autonomous recovery. Today there is no alert path — "no news is good news" is false; a connection can be dead for weeks invisibly. **The fix:** every transition INTO `needs_attention`/`blocked`/`terminal>threshold` (the human-required states) emits a **push escalation** (the web-push/notification surface already exists in the console) — a single, deduplicated "X needs you" signal. Hands-off does not mean silent; it means *silent until something genuinely needs a human, then loud exactly once.* Without this, every O3/honesty failure above persists indefinitely.

### 10-G. Out of scope but named: silent data corruption from schema drift. [O2 — data loss]

A provider deprecates a field; the connector still 200-OKs but ingests zeros — no 429, no gap, reported 100% while silently wrong. This is a **connector-correctness** concern (response validation), not the rate/governance loop, so it is outside this spec's three layers — but it is the most dangerous honesty failure and is recorded here so it is owned somewhere: it belongs to a per-connector response-shape contract (declared non-null fields, record-shape assertions) that fails the record into a `terminal`/validation gap rather than ingesting corruption. Tracked as a separate workstream, not closed here.

### New composition rules (added to §8 by the red-team)

8. **Unfillable work is terminal, counted, and visible — never silently dropped.** A bounded recovery budget against a non-transient error moves a gap to `terminal`, out of the fillable set but into a surfaced count. Makes "false 100%" and "poison-gap stall" impossible by construction.
9. **Recovery may decelerate the shared pacer, never accelerate it during a cooldown.** `recordSuccess` is suppressed for the cooldown-exempt recovery lane. Makes "recovery un-learns the back-off" impossible by construction.
10. **After long idle or stale warm-start, every lane re-enters cold.** No cold burst from a restored aggressive interval. Makes "stale warm-start bans the account" impossible by construction.
11. **Every human-required state escalates exactly once via push.** Hands-off is silent-until-it-isn't. Makes "dead for weeks, invisibly" impossible by construction.

---

### The durable answer, in one paragraph

Collect any source as fast as the provider safely allows by running **one** AIMD rate loop that probes a single behavioral ceiling — **the one number you author, set below the flagging threshold and never probed** — backs off multiplicatively on 429, never sums its waits, and turns everything it cannot fetch into durable reason-discriminated gaps. Govern across runs with two separate governors (pressure cooldown, failure backoff) that defer only the *forward walk* — recovery of non-pressure gaps is work-conserving and cooldown-exempt (but may only *slow* the shared pacer, never speed it), which is the one seam the live system gets wrong (§4). Make unfillable work **terminal, counted, and visible** — never silently dropped — so "converge to 100%" is honest: the *fillable* backlog drains to zero, the terminal set is bounded and surfaced (§10). Tell the owner the truth with **one** verdict that every surface derives from, never two — `cooling_off` for a throttled-but-succeeded connection that is *actually progressing*, `blocked`/`needs_attention` for a genuine terminal stop (incl. a dead-but-429ing provider that has stopped progressing), never both, never a Reconnect CTA for something that heals itself — and when a human is genuinely required, **escalate exactly once via push**, because hands-off means silent-until-it-isn't, not silent-forever (§10-F). Make every provider-specific quantity a declared profile field so "ANY source" is not secretly "ChatGPT." Everything else — caps, concurrency-AIMD, tailStop, the second factory — is incidental. That is the whole system; once §4 + §6 land together the live bug closes, and once §10 lands the unattended-forever guarantee becomes true rather than asserted.

**Final overall confidence: 96%.** The architecture (§1, §2.1, §5-corrected, §6.1, §8) is ≥96%; the rate-control refinements (§9-C2/C3/C4) and the provider-profile field set (§3) are 72–80% and isolated; the terminal-state/escalation model (§10) is 90% and NEW/unshipped. The 4% gap is named, not hidden — that is what "99% would be a lie here" looks like, and naming it is the point.
