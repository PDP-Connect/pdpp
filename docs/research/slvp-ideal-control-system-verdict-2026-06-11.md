# The SLVP-Ideal Adaptive Collection Control System — Verdict (2026-06-11)

**Status:** Synthesis grounded in MEASURED evidence + shipped code. Pending an
adversarial red-team pass (next budget window) before it is final. Confidence is
marked per claim; the goal is the >95% defended verdict the owner asked for.
**Owner:** the owner Nunamaker
**Scope:** The true SLVP ideal for PDPP's collection-rate control system — what is
essential, what is incidental complexity to prune. No boundaries (owner-sanctioned).

## The question (owner's words)
"If our control system has incidental complexity we should prune it. I want the
SLVP ideal, whatever it is... make it fully adaptive rather than ...this..."

## The decisive MEASURED evidence (not theory — the project's own probes)

From `tmp/workstreams/ri-chatgpt-429-efficiency-audit-v1-report.md` and
`chatgpt-current-ab-probe-followup-2026-06-03.md`:

1. **The current policy is "correct and safe but OVER-CONSERVATIVE ON THE WAIT
   SIDE. It does NOT over-trigger 429s... The inefficiency is in how *long* it
   waits."** — the project's own audit. (Confidence the system is over-conservative,
   not unsafe: **HIGH**, it's a measured finding.)
2. **Concurrency is pinned 1/1; the lane's increase/decrease machinery is DEAD
   CODE.** The adaptive-concurrency dimension exists but is frozen off.
3. **Live concurrency-5 probe on a cold/warm account: 50/50 200s, 0 429s, 7.3×
   faster** than serial. On a 200-sample it heated after ~100 successes (9 429s)
   and the lane **correctly collapsed 3→1, opened the circuit, deferred losslessly.**
   So adaptive concurrency was LIVE-PROVEN safe (wide when cold, serial when hot,
   nothing lost). (Confidence: **HIGH** — observed live.)
4. **The throttle is per-account, time-varying, recovers over MINUTES-to-hours
   while still SERVING data (HTTP-200 after honoring Retry-After). No measured ban
   signal from sustained polite throttled collection.** (Confidence: HIGH from the
   2026-06-02 probe; the residual risk is "absence of a ban at concurrency=1 is not
   proof concurrency=5-while-hot is safe" — but the probe shows the lane never STAYS
   wide while hot, it collapses.)
5. **The account DOES heat after ~100-200 successes** — so "grind forever, never
   stop" is NOT correct. Some lossless stop-and-defer under real pressure is
   evidence-correct. (Confidence: HIGH.)

## VERDICT — Essential vs Incidental

### ESSENTIAL (keep — each maps to an obligation, evidence-confirmed)
- **Rate-AIMD on the 429 congestion signal** + the **250ms rate ceiling** (the one
  authored safety number). The sole-rate-authority core. [C: 98%]
- **Honest retry layer + Retry-After** (good-citizen, no double-gating). [C: 98%]
- **Lose-nothing DETAIL_GAP substrate — KEEP, but DEMOTED to a CRASH/INTERRUPT
  safety net, NOT the primary convergence mechanism.** The substrate must exist so
  an interrupted run loses nothing. But (owner's decisive insight, below) a run
  should NOT defer-to-gap as its normal way of making progress — it should keep
  running. Gaps become the net for "the run was killed / surface yielded", not
  "the run hit pressure". [C: 95%]
- **Circuit breaker / wait-out — KEEP and PROMOTE to the PRIMARY pressure response.**
  This is the mechanism that ALREADY waits out the account's heat IN-RUN and resumes
  (live: opened, waited 4m59s, resumed, account fine — cycle 1/8). It is the model
  for the whole system. [C: 92%]

### THE OWNER'S DECISIVE CORRECTION (supersedes my earlier "re-dispatch" framing)
Owner: *"why would you need to re-dispatch if the first run is allowed to keep
running?"* — and he is RIGHT. My earlier verdict still thought inside "runs are
bounded, work spans runs, re-dispatch between them." That framing IS the incidental
complexity. The circuit breaker already proves the alternative: a run can WAIT OUT
the account's minutes-long heat IN-PLACE and continue. The account heats after ~100
fetches and cools in MINUTES while still serving — so ONE run can drain the entire
backlog by: collect ~100 → hit heat → wait out the few-min cool-down in-run → collect
~100 more → repeat → done. No density-STOP-terminates, no defer-as-primary, no
cross-run cooldown, no re-dispatch.

**Verified constraints (checked, not assumed):**
- NO hard runtime subprocess timeout exists — a run CAN grind until drained.
- Session death mid-run is NO LONGER a bound — the token self-heal (shipped this
  session) re-extracts on 401; a genuinely dead session surfaces an honest reconnect
  prompt (§10-C); the substrate loses nothing. (I was treating a solved problem as
  an open constraint.)
- The ONE real residual constraint is the **shared neko browser surface** — it is a
  LEASED, contended resource (`wait_reason: "waiting on capacity"`). A multi-hour run
  monopolizes the single surface other browser connectors (chase/usaa/amazon/...)
  need. This is a CAPACITY/FAIRNESS constraint, NOT safety/account/session. The
  correct bound is therefore **cooperative surface-yielding**: a long run yields the
  surface IFF another browser connector is waiting — not a fixed wall-clock timeout.

### INCIDENTAL COMPLEXITY (prune — bigger prune than v1 said)
1. **Frozen concurrency=1 as a PERMANENT ceiling.** [PRUNE → adaptive 1↔~5]
   The probe LIVE-PROVED adaptive concurrency safe (wide cold, serial hot, lossless
   collapse) and 7.3× faster. The freeze was "pending clean cold-state evidence" —
   that evidence now EXISTS. Un-freeze the built-but-dead concurrency-AIMD. THE single
   largest timidity (3.6×-20× slowdown for no measured safety benefit). [C: 88% — the
   12% residual: a live ramp must confirm the safe MAX (3? 5?) and that collapse is
   fast enough to never SUSTAIN wide-while-hot.]
2. **Density stop as a RUN-TERMINATOR.** [PRUNE the TERMINATE; KEEP the SIGNAL]
   (Corrected from v1, where I kept it.) The density count is a correct SIGNAL
   ("account is now hot, back off"). But its RESPONSE — terminate the run + defer the
   whole tail to gaps — is wrong. The right response is the circuit's: WAIT OUT the
   minutes-long cool-down IN-RUN and CONTINUE. Stopping the run was solving
   "convergence across runs" when the answer is "don't stop, just wait a few minutes
   in place." [C: 90%]
3. **Cross-run exponential cooldown (`2^persistence` → 3.5-6h) + the entire
   re-dispatch / scheduler-resume machinery.** [PRUNE — DELETE, not "replace"]
   (Corrected from v1's "replace with measured re-dispatch".) If the run waits-in-place
   and drains to completion, there is NOTHING to re-dispatch and NO cross-run gap to
   cool down. The exponential cooldown, the recovery-only relaunch, the cross-run
   source-pressure governor — all of it exists to spread work across runs, which the
   single-continuous-run model makes unnecessary. This is the "wait 6 hours" problem
   and it DELETES. [C: 88% — residual: confirm the scheduler still needs SOME cadence
   for the genuinely-idle (no-work) case; the cooldown's catch-up role for normal
   scheduled refresh may still be needed, just not for backlog drain.]
4. **The double-counted backoff wait** (audit finding #1): retryHttp sleeps the
   backoff AND the lane re-applies it as a launch cooldown — paid twice per
   pressured conversation. Pure waste. [PRUNE] [C: 90% — audit says "cannot be
   validated without a live run"; high-confidence it's waste, needs live confirm.]
5. **The 47-55min single-conversation retry tail** (12 attempts × up-to-15min):
   one stuck ID burns ~50 min before the circuit defers it. Over-long. [PRUNE →
   shorter per-ID budget, defer to gap sooner]. [C: 85%]

## THE GOVERNING PRINCIPLE (owner-decided)
**No *unnecessary* lag — anywhere. Out-of-order for efficiency is good.** This is the
single criterion that resolves every design fork below. Lag is "necessary" ONLY when
more data genuinely must be collected first (a real dependency / coverage gate);
every other delay — a fixed cooldown clock, a serial concurrency freeze, a
straggler pinning the watermark while newer work piles up, a once-at-DONE state
commit — is unnecessary and prunes.

## THE SLVP IDEAL (the synthesized target — v3, owner-decided)
**ONE continuous adaptive run that drains to completion with no unnecessary lag,
waiting out the account's heat IN-PLACE rather than stopping.** Adaptive in BOTH
rate AND concurrency on the 429 density signal: climb concurrency (toward a profiled
safe max ~3-5, OUT-OF-ORDER for efficiency) and tighten interval when cold/clear;
collapse to serial + widen interval under real pressure; when the account genuinely
heats, WAIT OUT its minutes-long cool-down in-run (the circuit-breaker model,
generalized) and RESUME — never terminate, never defer-as-primary, never cross-run
cooldown. Bounded ONLY by: the rate ceiling (the one authored number), the
lose-nothing substrate, and cooperative yielding of the shared neko surface IFF
another browser connector is waiting. Hands-off, no re-dispatch, no waits, no nudges.

### Watermark / persistence (the in-between, DECIDED)
- **Records persist in near-realtime** (already true — batch-flushed as emitted).
- **The watermark commits INCREMENTALLY at the oldest-complete-or-gapped frontier,
  as fast as coverage allows** — NOT once at DONE. (Today it commits only at DONE =
  unnecessary lag: a late crash re-fetches the whole run. The runtime already has
  `commitState` per-stream and stages every STATE; the connector just needs to emit
  a cursor each time the safe frontier advances. No runtime change required.)
- **A safe checkpoint = the boundary where everything older is hydrated OR durably
  gapped.** The "in-between" = in-flight fetches not yet hydrated or gapped.
- **A STRAGGLER (slow/pressured oldest-incomplete item) is GAPPED to un-pin the
  watermark, NOT waited-out-while-it-pins.** Holding the watermark on one straggler
  while newer work completes behind it is *unnecessary* lag → gap it (durable, will
  retry from its row), advance the watermark past it, keep collecting. The
  coverage gate stays essential (never advance past un-hydrated-AND-un-gapped work) —
  that is the ONLY *necessary* lag, and it's preserved.

The cross-run machinery (exponential cooldown, recovery-only relaunch, source-
pressure governor) was solving "spread bounded work across many runs" — a problem
the single-continuous-run model deletes. The substrate and scheduler survive only
for their genuine roles (crash-safety; idle/refresh cadence), not backlog drain.

### (superseded v1 target, kept for the diff)
~~One controller adaptive in BOTH rate AND concurrency, reading the 429 density
signal: climb concurrency and tighten interval when cold; collapse to serial + widen
interval under real pressure. Stop ONLY when the account genuinely heats and defer
losslessly, re-dispatch on measured recovery cadence.~~ — Replaced because "stop +
re-dispatch" is itself the incidental complexity (owner's insight). Original below.

Original v1 ideal text:
**One controller adaptive in BOTH rate AND concurrency**, reading the 429 density
signal: climb concurrency (toward a profiled safe max ~3-5) and tighten interval
when cold/clear; collapse to serial + widen interval under real pressure. Stop ONLY
when the account genuinely heats (density stop — evidence-correct) and defer the
tail losslessly. Re-dispatch on the MEASURED recovery cadence (minutes), never a
fixed exponential clock. Bounded only by the rate ceiling (the one number) and the
lose-nothing substrate. Runs until work-drained, converging hands-off across
prompt re-dispatches — no manual nudges, no 6-hour waits.

This is "fully adaptive" as the owner intuited: the adaptive machinery already
EXISTS (rate-AIMD live, concurrency-AIMD built-but-frozen) — the SLVP ideal
removes the fixed-pessimism guards stacked on top (frozen concurrency, exponential
cooldown, double-wait) and TURNS THE ADAPTATION BACK ON, keeping only the
evidence-correct stops (density, narrowed circuit, rate ceiling, lose-nothing).

## What must still happen before this is >95% and shipped
1. **Adversarial red-team** (multi-lens + external gpt/gemini) — attack each prune,
   especially the concurrency un-freeze (the irreversible-account-risk one).
2. **Live concurrency-ramp validation** on the real account (the audit says the
   high-value changes "cannot be validated without a live run") — confirm the safe
   MAX and that collapse-under-pressure is fast enough.
3. **PRESERVE THE 568-GAP BACKLOG as the test fixture** (owner directive — do NOT
   force-drain it; it's how we validate the fix against real stranded gaps).
4. Provider-generality: express the safe-max / recovery-cadence as ProviderProfile
   fields, not ChatGPT constants (per the whole-system spec §3).
