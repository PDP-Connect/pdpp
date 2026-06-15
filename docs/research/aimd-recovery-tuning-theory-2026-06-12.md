# AIMD Recovery-Dynamics Tuning Theory — ChatGPT Pacer Slow-Recovery Pathology

Date: 2026-06-12
Author: research subagent (final-drain worktree)
Scope: theory + prior-art for tuning `ProviderPacing` recovery after sporadic 429 spikes.
Companion: `client-rate-governance-prior-art-2026-06-10.md` (covers AWS/Netflix/Envoy/SRE
*landscape*; this doc covers *recovery dynamics* — the slow-recovery-after-spike axis that
the landscape doc does not touch: it has 0 mentions of recovery/responsiveness/time-based/BBR).

---

## 0. The artifact under study (grounded in deployed code)

`packages/polyfill-connectors/src/provider-pacing.ts` (deployed). The controller paces by an
**inter-request interval** (ms), inverse of a rate. Relevant mechanics:

- Throttle (plain 429, no Retry-After): `recordThrottle()` →
  `interval = max(initialIntervalMs, interval / multiplicativeDecreaseFactor)`
  (provider-pacing.ts:367-368). With `multiplicativeDecreaseFactor=0.5` this **doubles** the
  interval per throttle. Several throttles in a burst compound multiplicatively: 2 → ×4, 3 → ×8.
- Success: `recordSuccess()` → `interval = max(minIntervalMs, interval − additiveStepMs())`
  (provider-pacing.ts:319), where (provider-pacing.ts:328-336):
  `step = floor(additiveIncreaseMs + recoveryGain × max(0, interval − initialIntervalMs))`.
  With `additiveIncreaseMs=100`, `recoveryGain=0.1`, `initialIntervalMs=1000`: at interval `I`,
  `step ≈ 100 + 0.1·(I−1000) ≈ 0.1·I` for large `I` — i.e. **~10% of the current interval per
  success** (matches the observed 51614→46453→… sequence, each ~0.9×).
- ChatGPT constants (`connectors/chatgpt/index.ts`): `CHATGPT_DEFAULT_PACING_MIN_INTERVAL_MS=250`
  (index.ts:356) = rate ceiling 240/min; `initialIntervalMs` default 1000ms;
  `recoveryGain` tunable via `PDPP_CHATGPT_PACING_RECOVERY_GAIN` (index.ts:338,521).
- **Cadence (the load-bearing fact):** `recordSuccess` fires **once per completed
  conversation-detail fetch** (index.ts:3164), and each fetch is gated by exactly **one
  pre-flight pacing wait of one (current, inflated) interval**. So a recovery step is *earned*
  only by paying one inflated interval. Recovery cadence ≡ the throttled rate. This is the
  structural coupling the rest of this doc dissects.

Observed pathology (run_1781276935196, current code): one isolated 429 → interval ×4–10 →
~14 interval-spaced successes (~6–7 min) to climb back; account is ~idle (1×429/30min) yet the
run crawls at ~1 conv/2min because it spends most of its time recovering from spikes that
recovery cannot outrun.

---

## 1. Q1 — Does Chiu & Jain say anything about RECOVERY TIME, or only steady-state fairness?

**Answer: only steady-state efficiency+fairness. The 1989 proof is silent on recovery/transient
time, and that silence is a known limitation that spawned a whole follow-up literature.**

Chiu & Jain (1989), "Analysis of the Increase/Decrease Algorithms for Congestion Avoidance in
Computer Networks," *Computer Networks and ISDN Systems* 17(1). The result: among linear
increase/decrease policies, **AIMD is necessary and sufficient to converge to an efficient AND
fair operating point regardless of initial state**. Proof is by the vector-diagram /
efficiency-line–fairness-line geometry (and an algebraic companion). It establishes *that*
convergence happens; it is an **existence** result, not a **rate** result.

Crucially for us: the proof's model is **N competing flows sharing one bottleneck under
synchronized feedback**, and "fairness" is the whole point — it's why additive (not
multiplicative) increase is mandatory (see Q2). **Our regime has N=1.** There is no fairness
line to converge to; the only thing that matters is the *responsiveness* axis the proof
deliberately abstracts away. Citing Chiu-Jain to justify a *slow* recovery is a category error:
the proof neither requires nor blesses slow recovery — it simply doesn't speak to recovery time
at all.

The follow-up literature exists precisely because the original proof ignored transient/recovery
time: AIMD-FC ("AIMD — Fast Convergence") and variable-structure-control reformulations
explicitly add machinery to **speed convergence/responsiveness** while preserving the
fixed-point Chiu-Jain guaranteed. That work is the standing acknowledgment that *recovery speed
is an open tuning dimension orthogonal to the convergence proof.*

> Takeaway: there is no theoretical debt incurred by making recovery faster. The convergence
> guarantee constrains the *fixed point* and the *signs* of the operators (increase additive,
> decrease multiplicative), not how many successes recovery takes.

Sources:
- Chiu & Jain summary: https://people.eecs.berkeley.edu/~fox/summaries/networks/chiu_jain
- AIMD overview (four-policy comparison, geometry): https://en.wikipedia.org/wiki/Additive_increase/multiplicative_decrease
- AIMD-FC (fast convergence follow-up): https://www.worldscientific.com/doi/10.1142/9789812776730_0041
- Variable-structure / responsiveness reanalysis: https://www.sciencedirect.com/science/article/abs/pii/S0005109812001239
- Lecture notes (synchronous-feedback model, vector diagram): https://anirudhsk.github.io/teaching/lectures/lec7.pdf

---

## 2. Q2 — Is proportional-per-success increase still "AI" (Chiu-Jain), or MIMD? Does it break convergence?

**Answer: our step is NOT pure additive-increase, but it is ALSO not MIMD. It is exactly the
MAIMD (Multiplicative-And-Additive-Increase / Multiplicative-Decrease) form, which Chiu & Jain's
own framework proves DOES converge. So proportional recovery does not break convergence — but
the reason it's safe is N=1, not the MAIMD theorem.**

Decompose our step:
`Δinterval = additiveIncreaseMs + recoveryGain·(interval − initialIntervalMs)`
= a constant term (additive) **plus** a term proportional to the controlled variable's distance
above a baseline (multiplicative-in-the-distance). A pure multiplicative-increase rule would be
`x ← α·x`; a pure additive rule is `x ← x + b`. Ours is `x ← x + b + g·(x − x0)`, i.e.
`x ← (1+g)·x + (b − g·x0)` — an **affine** update = a multiplicative component **and** an
additive component. That is the textbook MAIMD shape.

Why this matters for convergence theory:
- **Pure MIMD does NOT converge to fairness.** Multiplicative increase preserves the *ratio*
  between flows (the state slides along a line through the origin, slope x2/x1, never
  approaching the x1=x2 fairness line). An unfair allocation stays unfair. This is the standard
  Chiu-Jain result and the reason TCP uses additive increase.
- **MAIMD DOES converge.** Adding any additive term to a multiplicative-increase rule restores
  fairness convergence — Chiu & Jain proved MAIMD schemes converge to fairness. This is not
  folklore; it's the design basis of MIT's ABC controller, whose authors note their base rule is
  MIMD ("does not provide fairness"), so they "add an additive-increase component," making it
  "a multiplicative-and-additive-increase/multiplicative-decrease (MAIMD) scheme. Chiu and Jain
  proved that MAIMD schemes converge to fairness."

So the in-code comment's claim that the step "remains ADDITIVE in the Chiu-Jain sense"
(provider-pacing.ts:60) is **imprecise**: with `recoveryGain>0` it is not additive, it is
MAIMD. But the *conclusion* (convergence preserved) is correct for a stronger reason than the
comment gives:
1. MAIMD converges anyway (the ABC/Chiu-Jain result), AND
2. **N=1 makes fairness moot entirely** — there is no second flow whose ratio could be
   preserved. The only fixed point is the rate ceiling (`minIntervalMs`), and *any* increase
   rule with a multiplicative-decrease counterpart and a non-zero increase will walk down to it.
   The MIMD "unfairness" failure mode is literally unreachable with one client.

> Takeaway: proportional recovery is convergence-safe. Don't justify it as "still additive" —
> justify it as **MAIMD (provably convergent) operating in an N=1 regime where the fairness
> constraint that motivates additive-only increase does not apply.** This frees you to choose
> the increase shape for *responsiveness* without a convergence penalty.

Sources:
- MIMD preserves ratio / does not converge; MAIMD converges (ABC paper, §"To achieve fairness, we add an additive-increase component… MAIMD… Chiu and Jain proved… converge to fairness"): https://arxiv.org/pdf/1905.03429
- Four-policy fairness summary: https://en.wikipedia.org/wiki/Additive_increase/multiplicative_decrease
- MIMD fairness analysis: https://www.researchgate.net/publication/4165567_Fairness_in_MIMD_congestion_control_algorithms

---

## 3. Q3 — Is "recovery rate bounded by the interval being recovered" a known anti-pattern? What do CUBIC / BBR / AWS do?

**Answer: YES — it is the canonical "ACK-clocked / self-clocked recovery" limitation, and the
three reference systems you named ALL fix it the same way: they decouple the recovery cadence
from the throttled send rate by making recovery a function of WALL-CLOCK TIME since the last
congestion event, not a function of how many sends/successes have occurred.**

The anti-pattern named: in classic Reno/Tahoe, the congestion window grows *per ACK* (or per
RTT), so the increase clock IS the (degraded) delivery clock. After a deep multiplicative cut on
a long-RTT or throttled path, "one increase per RTT" means recovery time scales with the very
RTT/rate that the loss inflated. This is the **"RTT-unfairness / slow-recovery on long fat
networks"** problem. Our pacer is the rate-domain twin: "one step per success," and a success
costs one inflated interval, so recovery time scales with the inflated interval. Same bug,
different units.

### 3.1 TCP CUBIC — recovery as a cubic function of *elapsed real time*
CUBIC's defining move: **"CUBIC does not rely on the cadence of RTTs to increase the window
size… window size is a cubic function of the time since the last congestion event."** Concretely
`W(t) = C·(t − K)³ + W_max`, where `t` = **real seconds since the last loss**, `K =
∛(W_max·(1−β)/C)` = time to climb back to the pre-loss window, `β`=0.7 (30% cut), `C`=scale.
Window updates happen on a wall-clock schedule "at regular intervals, based on the amount of time
elapsed since the last congestion event, rather than only when ACKs arrive." This is *exactly*
the decoupling we lack: a flow whose ACKs are slow (our: whose successes are interval-spaced)
still recovers on the real-time clock. The concave region snaps the window back toward W_max
**fast** (most of the recovery happens early, independent of ACK pacing), then a plateau, then a
cautious convex probe above W_max.

### 3.2 AWS SDK adaptive-retry — literally CUBIC, in the rate domain, and TWO clocks
AWS's `DefaultRateLimiter` is the closest analog to our problem (single client, provider
throttles sporadically, recover in seconds-minutes). Its recovery is **`_CUBICSuccess(time())`** —
`calculatedRate = scaleConstant·(timestamp − lastThrottleTime − timeWindow)³ + lastMaxRate`
where `timeWindow = ∛(lastMaxRate·(1−β)/scaleConstant)`. The recovered rate depends only on
**timestamp − lastThrottleTime** (wall-clock since last throttle), NOT on how many requests
succeeded in between. Two structural lessons we are missing:
1. **Recovery clock ≠ send clock.** `_CUBICSuccess` reads `time()`; recovery would advance the
   same way whether 1 or 100 requests went out in that span.
2. **The pacing wait is a SEPARATE bucket.** `acquire()` sleeps `(amount − capacity)/fill_rate`
   off a token bucket whose `fill_rate` is *set by* the CUBIC curve. The wait (send pacing) and
   the recovery curve are decoupled — the recovery math runs on the clock, the bucket merely
   enforces whatever rate the curve currently dictates. Our pacer collapses these into one
   variable (`_currentIntervalMs` is both the wait AND the thing recovery mutates per success).
3. **Dormant-until-first-throttle** (AWS enables the limiter only after the first 429) — relevant
   to "mostly idle account" regimes; no steady-state tax when the provider isn't pushing back.

### 3.3 BBR — recovery is rate-modeled, paced by a clock, and does NOT treat one loss as a cut
BBR is the strongest statement of the principle: **"transmits based on a clock, not ACKs,"** and
`pacing_rate` is its primary control, set from a *measured* bottleneck-bandwidth model, not
ratcheted by per-ACK events. A single loss does **not** force a multiplicative cut — loss is not
BBR's primary signal — so the "one 429 → ×4–10" amplification simply doesn't exist in BBR's
model; the rate tracks measured throughput. BBR is probably *too* far from our setting to adopt
wholesale (we don't measure provider bandwidth, and ignoring 429s entirely is unsafe against a
real rate limiter), but it validates the direction: **clock-driven, model-based rate, with loss
de-emphasized as a one-shot multiplier.**

> Common thread across all three: **separate the recovery cadence from the degraded transport
> rate.** CUBIC and AWS do it with a *time-since-last-event* curve; BBR with a *measured-rate
> model on a pacing clock*. None of them let "one recovery step cost one degraded interval."

Sources:
- CUBIC time-based growth, concave/convex, W(t)=C(t−K)³+W_max, decoupled from ACK/RTT: https://en.wikipedia.org/wiki/CUBIC_TCP ; RFC 9438 https://www.rfc-editor.org/rfc/rfc9438.html ; original paper https://www.cs.princeton.edu/courses/archive/fall16/cos561/papers/Cubic08.pdf
- AWS adaptive-retry CUBIC rate limiter (`_CUBICSuccess(time())`, `_CUBICThrottle`, acquire sleeps (amount−capacity)/fill_rate, dormant-until-first-throttle): https://github.com/aws/aws-sdk-js-v3/commit/8ef104d00eac33cf1a94c54e2daa2d1bff89a0a4 ; https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html ; https://aws.amazon.com/blogs/developer/announcing-updated-retry-behavior-for-aws-sdks-and-tools/
- BBR clock-not-ACK pacing, rate-model, loss de-emphasized: https://queue.acm.org/detail.cfm?id=3022184 ; IETF draft https://datatracker.ietf.org/doc/html/draft-cardwell-iccrg-bbr-congestion-control-02

---

## 4. Q4 — Tuning problem (constants wrong) or STRUCTURAL problem (per-success recovery is inherently too slow)?

**Answer: STRUCTURAL, with a tuning amplifier on top. The asymmetry is built into "recovery is
clocked by successes, and each success costs one inflated interval." No setting of the existing
constants removes it; it can only be *reduced* (and reducing it via `recoveryGain` pushes you
toward MIMD-shaped per-step jumps, which is the wrong lever). The reference systems all fixed it
structurally, not by retuning the per-success step.**

The asymmetry decomposed:
- **Decrease side** is *event-clocked and cheap*: a 429 arrives on the provider's clock and
  multiplies the interval instantly (×2 per throttle; a 3-burst → ×8) in **zero of our time**.
  One signal, large effect, paid for by the provider.
- **Increase side** is *self-clocked and expensive*: each recovery step requires one successful
  fetch, and a successful fetch costs **one full current (inflated) interval** of wall time. To
  undo a ×8 jump at 10%/step takes ~⌈ln(8)/ln(1/0.9)⌉ ≈ 20 steps, and those steps are spread
  across a shrinking-but-still-large interval sum. Recovery wall-time ≈ Σ intervals over the
  climb ≈ several × the inflated interval. **You pay for recovery in the inflated currency you're
  trying to escape.**

Why it's structural, not just constants:
1. **`recoveryGain` can't fix it.** Cranking gain toward 1.0 makes each step ~undo the prior
   doubling, but (a) that *is* MIMD-shaped (a per-step multiply of the controlled variable) —
   the comment's own "do not violate" constraint (provider-pacing.ts:60) bars it, and rightly,
   because near the ceiling it would overshoot; and (b) even at gain that recovers in a few
   steps, those few steps still each cost ~one inflated interval, so the *first* step after a
   137s spike still costs ~137s. The floor on recovery wall-time is "≥ one inflated interval,"
   set by the cadence, not the gain.
2. **`multiplicativeDecreaseFactor` / Retry-After handling don't fix it.** The code already
   wisely refuses to bake Retry-After into the sustained interval (provider-pacing.ts:353-369,
   Part B) — good, that prevents a 100s Retry-After becoming the steady rate. But a *plain*
   throttle still doubles, and a sporadic burst still inflates faster than per-success recovery
   can drain. Softening the decrease factor reduces the spike height but not the recovery
   *cadence* coupling.
3. **The mostly-idle regime makes it worse, not better.** With ~1×429/30min, the provider is
   telling you the sustainable rate is near the ceiling. But after each isolated spike the pacer
   spends minutes recovering, so the *effective* rate is dominated by recovery transients, not by
   the (near-ceiling) steady state the provider actually permits. The controller is integrating
   noise (one stray 429) into a multi-minute rate penalty.

The fix is structural and matches §3: **decouple the recovery cadence from the send interval.**
Concrete options, in rough order of how closely they track the prior art:

- **(A) Time-based recovery (CUBIC / AWS adaptive shape).** Make the interval a function of
  `now − lastThrottleTime`, recovered on a wall-clock schedule, not per-success. After a spike,
  the interval decays toward `minIntervalMs` on the real clock regardless of how few fetches
  happen in between. This is the *direct* analog the in-code comment already gestures at
  ("the direct analogue of AWS adaptive-mode CUBIC", provider-pacing.ts:57) — but the
  implementation only borrowed the *shape* (distance-proportional step) while keeping the
  *per-success clock*, which is the half that doesn't matter. The load-bearing half of CUBIC/AWS
  is the **`time()` argument**, and that's the half that's missing.
- **(B) Recover-on-a-fixed-clock independent of fetches.** A periodic tick (e.g. every
  `initialIntervalMs`) applies recovery steps whether or not a fetch completed, so an idle/slow
  span still heals the interval. (This is what "window updates at regular real-time intervals,
  not only on ACKs" buys CUBIC.)
- **(C) Cap the spike's *persistence*, not just its *height*.** Treat an isolated 429 as a
  one-shot (like the existing Retry-After path) rather than a sustained-rate statement unless
  throttles *recur* within a window — i.e. require a *density* of 429s (throttle rate, as AWS
  measures `measured_tx_rate` of throttled vs non-throttled) before adopting a slower sustained
  interval. One 429 in 30 min should barely move the sustained rate; the current code lets it
  multiply it ×4–10.
- **(D) Asymmetry-aware floor on recovery wall-time.** At minimum, bound the *number of inflated
  intervals* any single spike can cost (e.g. recover by larger absolute jumps when the interval
  is far above `minIntervalMs` AND few throttles seen recently), so the recovery time is bounded
  in seconds, not in "successes × inflated-interval."

> Verdict: **structural.** The constants (gain, decrease factor) are second-order; the
> first-order defect is that recovery is clocked by the throttled rate. Every reference system
> (CUBIC, AWS adaptive, BBR) fixes this by clocking recovery on wall-time / a measured-rate
> model. Recommend (A)+(C): time-based recovery decay + density-gated adoption of sustained
> slow-downs, so an isolated 429 against a mostly-idle account is a brief blip, not a multi-minute
> tax. Keep MAIMD convergence reasoning from Q2 — it permits whatever increase shape you pick.

---

## 5. One-paragraph executive summary

Chiu-Jain (1989) proves AIMD converges to a fair+efficient fixed point but says **nothing about
recovery time** — recovery speed is an orthogonal tuning dimension the proof abstracts away, and
later work (AIMD-FC, variable-structure control) exists precisely to speed it. Our
proportional-per-success step is **MAIMD, not pure AI**; MAIMD still converges (ABC/Chiu-Jain),
and in our **N=1** regime the fairness constraint that mandates additive-only increase doesn't
even apply — so the increase shape is free to optimize for responsiveness. The core pathology —
**recovery clocked by successes, each costing one inflated interval** — is the classic
ACK-clocked/self-clocked-recovery anti-pattern, and it is **structural, not a constants problem**:
no `recoveryGain`/`multiplicativeDecreaseFactor` setting removes the "≥ one inflated interval per
recovery step" floor. TCP CUBIC, the AWS SDK adaptive rate limiter, and BBR all fix exactly this
by **decoupling the recovery cadence from the degraded transport rate** — CUBIC/AWS via a
`time-since-last-throttle` recovery curve (`W(t)=C(t−K)³+W_max` / `_CUBICSuccess(time())`), BBR
via a clock-paced measured-rate model. The deployed code borrowed CUBIC's *distance-proportional
step shape* (provider-pacing.ts:57) but kept the *per-success clock*, which is the half that
causes the pathology. Fix: make recovery a function of wall-clock time since the last throttle
(time-based decay), and gate adoption of a slower *sustained* interval on throttle *density*
(one stray 429/30min must not multiply the sustained rate ×4–10), as AWS does with its
throttled-vs-nonthrottled rate measurement.
