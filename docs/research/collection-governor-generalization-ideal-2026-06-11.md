# Collection-Governor Generalization — The TRUE SLVP-Ideal Abstraction for Fastest-Safe Collection

**Status:** Corpus — defended architecture verdict (lead design architect)
**Owner:** the owner Nunamaker
**Created:** 2026-06-11
**Scope:** Resolve the fork left open by the SLVP-adaptive-collection verdict — *generalize* fastest-safe collection into (a) a runtime capability new connectors inherit ~for free and (b) one abstraction across modalities IF API and browser are genuinely one control problem. Decide honestly: same loop with a pluggable signal/envelope, or a categorically different controller (distribution-matching to look human) that must NOT be force-merged.

**Inputs reconciled:**
- **Frame 1** — browser-pacing *practice* (Plaid screen-scraping, Apify / Bright Data / Browserbase canon, the five-layer anti-bot model, CAPTCHA-as-last-resort).
- **Frame 2** — *control-theory* decomposition (the 4 layers: loop / signal / objective-near-ceiling / actuator) per modality.
- **Frame 3** — the *current-code seam* map (shared stack in `packages/polyfill-connectors/src`, ChatGPT-specific, the 6 API connectors, browser `politeDelay`, the empty `BrowserCollectContext` field).
- **Prior corpus:** [`slvp-adaptive-collection-ideal-2026-06-11.md`](./slvp-adaptive-collection-ideal-2026-06-11.md) (the API single-loop verdict, 96% conf), [`client-rate-governance-prior-art-2026-06-10.md`](./client-rate-governance-prior-art-2026-06-10.md) (AWS adaptive / Netflix / Scrapy / Finagle / GCRA), [`congestion-control-theory-for-http-rate-governor-2026-06-10.md`](./congestion-control-theory-for-http-rate-governor-2026-06-10.md).
- **Live code read for this verdict (not memory):** `send-governor.ts`, `connector-http-governor.ts`, `runtime-capabilities.ts`, `connector-runtime.ts` (`BaseCollectContext` / `BrowserCollectContext`, lines 106–135), `provider-pacing.ts`, `adaptive-lane.ts`, `provider-budget.ts`; the 6 API connectors' single `createConnectorHttpGovernor({ name, maxAttempts: 1 })` call; the browser connectors' hand-rolled `politeDelay` sites (amazon 800ms, usaa 4000/5000/6000ms settle constants, reddit 500ms page delay).

---

## 1. THE VERDICT

**It is a shared loop SCAFFOLD + two genuinely different controllers. Not one abstraction with a pluggable signal; not two unrelated things. The shared surface is the *seam* (the single pre-flight `SendGovernor` / `SendDelayHint` + the `DETAIL_GAP` substrate + the gap/run-budget re-entry mechanism), which already exists and is modality-neutral. The controller that plugs into that seam is genuinely different per modality, because the *objective function* differs in sign, not just the signal.**

Stated as the principle: **the plumbing is one thing; the policy is two things.** A new connector inherits fastest-safe collection by inheriting the *seam* (Phase A, not in doubt). API connectors plug an AIMD rate controller (already built: `ProviderPacing`). Browser connectors plug a human-envelope controller (does not exist yet; build it). Forcing the *controller* to be one abstraction is the incidental-complexity trap in reverse — it would give API connectors mandatory jitter/floors that fight throughput, and give browser connectors AIMD ceiling-discovery + warm-start that actively *harms* undetectability.

**Confidence:**
- **97%** that API and browser are different *controllers* (objective layer diverges in sign; all three frames converge independently — practice, control-theory, and code each reach this without the others).
- **95%** that the right shared abstraction is the existing `SendDelayHint`/`SendGovernor` seam + gap substrate, NOT a new shared governor superclass (the seam is already transport-agnostic `() => number`; the AIMD loop body is not reusable).
- **~80%** on whether the browser controller's *signal* (latency / behavioral-challenge) is reliably observable through the neko/Playwright path to drive a graduated response, or is too noisy to be more than a binary challenge-detector. This is the same ~80% the prior SLVP doc flagged (Attack 3, unmeasured) and it does not move the verdict — it only changes how rich the browser controller's signal layer can be.

### Why not "one loop, pluggable signal/envelope" (the elegant answer that fails)

The structural seam is genuinely shared and pluggable — `AdaptiveLane.launchDelayHint?: () => number` and `SendDelayHint.nextDelayMs()` take any source. So the *temptation* is real: API plugs a 429-driven hint, browser plugs a challenge-driven hint, the loop is shared. **This fails at the objective layer, and the objective layer sets the SIGN of the control action:**

| | API AIMD (`ProviderPacing`) | Browser distribution-matching |
|---|---|---|
| Objective | Maximize throughput under a quota ceiling | Stay inside a human behavioral envelope |
| Speed direction | Faster is better until the ceiling | Neither faster nor slower is the goal — **variance** is the goal |
| Response to a clean success | **Decrease** interval (probe toward ceiling) | Do **NOT** decrease — speeding up after a clean run is exactly the bot fingerprint |
| Jitter | Nice-to-have anti-stampede add-on | **Load-bearing** structural requirement (uniform 1.0s ± 0.05 is trivially flagged) |
| Floor | AIMD actively tries to go *below* it | A hard human floor (no human reads a page in <800ms) the controller must respect |
| Signal | Discrete 429 + `Retry-After` (exact, reliable) | Composite session-trust score: CAPTCHA, re-auth interstitial, empty-where-non-empty, session drop — qualitative, lagged, no numeric "retry in N" |
| Warm-start | Persist learned faster interval across runs (reward) | **Inverts** — sessions are intentionally fresh identities; a persisted "fast interval" is an anti-pattern |
| Actuator | One scalar inter-request interval | Multidimensional: inter-navigation delay, dwell, scroll velocity, mouse path — the *shape* of the distribution is the safety property |
| Failure mode | Recoverable (429 → back off → resume) | Often **irreversible** (account flagged/banned), arrives hours/days after the triggering behavior |

AIMD's `recordSuccess → additive-decrease` is a *structurally wrong action* for browser pacing. A "shared loop" forced over both would require the browser plugin to override increase-on-success so thoroughly that the shared loop does none of the work — a thin interface over two unrelated behaviors, all cognitive cost, zero reuse. That is the incidental-complexity trap (Frame 2's exact phrasing) in reverse.

**What IS genuinely one thing (and is already built):** the *plumbing* — exactly one pre-flight wait per request path (the `SendGovernor` doctrine, enforced by `PreflightWaitProbe` asserting `count === 1`); the `DETAIL_GAP` + reason-discrimination substrate (`upstream_pressure` vs `run_cap_deferred`); the `RunBudget` + gap-deferral cross-run "lose nothing" mechanism. All three are modality-neutral today. The browser controller routes its challenge signal to the `interaction-handler` / `browser-handoff` pipeline (re-establish session trust), not to a `recordThrottle()` analogue — and it slots into the *same* single-wait seam via `launchDelayHint`, preserving the no-stacking invariant.

---

## 2. THE MINIMAL ABSTRACTION SHAPE — the runtime-capability injection point

**Goal:** a connector gets fastest-safe collection *by default*, ~zero adoption surface. Today adoption is opt-in (`pacingInitialIntervalMs` defaults to **0** → no pacing wait; warm-start, `collection_rate` progress, and the lane are all hand-wired per connector; the 6 API connectors get a *live but silent* governor). The fix is to move the governor construction from the connector to the **runtime**, keyed off the connector manifest.

**The seam to name:** the contract between `runtime-capabilities.ts` (which currently only *gates placement* — it decides *where* a connector runs and injects *nothing*) and the `CollectContext` / `BrowserCollectContext` struct the runtime hands every `collect()`.

- **`BaseCollectContext`** (`connector-runtime.ts:106`) is the single struct every connector's `collect()` receives. It has `emit`, `emitRecord`, `progress`, `state`, `requestDetailGapPage`, … and **no governor field**.
- **`BrowserCollectContext`** (`:132`) extends it with `page` + `context` — and likewise no pacing field. The browser connector is handed a `Page` and left to hand-roll `politeDelay`.

**The injection point (new):** the runtime constructs the correct controller from a manifest **`collection_profile`** (the natural home — the Collection-Profile contract already carries `runtime_requirements.bindings`) and injects it into the context as a single field:

```ts
// BaseCollectContext gains ONE field:
sendGovernor: SendGovernor;          // the single pre-flight wait, runtime-owned

// The runtime builds it from the manifest, NOT the connector:
//   bindings include "browser"  → BrowserEnvelopeGovernor  (human-envelope policy)
//   bindings are network-only    → ProviderPacing-backed governor (AIMD), warm-start
//     seeded from STATE cursor, collection_rate progress auto-emitted
```

The manifest `collection_profile` carries the per-modality policy inputs only — the *values* that are connector-specific (safe interval ceiling for an API; per-action human-delay ranges + challenge selectors for a browser). The *loop/policy machinery* is runtime-owned and shared by all connectors of that modality. This is the "runtime capability" the owner asked for: `runtime-capabilities.ts` graduates from *placement-only* (which runtime can satisfy the bindings) to *placement + governor provisioning* (the runtime that satisfies the bindings also injects the matching fastest-safe governor).

**Why this is the right seam (not a connector helper):** putting it on the context makes fastest-safe collection a **runtime guarantee** — a connector author cannot forget it, cannot mis-stack two gates (the `SendGovernor` interface has no two-governor combinator by design), and gets warm-start + observability without writing the 50-line STATE-cursor persistence the ChatGPT connector hand-rolls today (`readChatGptPersistedPacing` etc.). New connector author surface drops from "wire a governor + warm-start + progress" to **"declare your modality in the manifest; await `ctx.sendGovernor.acquire()` before each request (or let the browser helper do it)."**

---

## 3. BROWSER: does the AIMD loop apply, or does browser need a distinct pacer?

**Defended position: browser needs a DISTINCT pacer. The AIMD loop body does NOT apply; the seam does.**

The argument *for* reuse is the latency-driven Scrapy-AutoThrottle analogy (probe toward a *target latency*, not maximum throughput) — superficially closer to "stay in an envelope." But it maps poorly twice over:

1. **Browser latency is dominated by page-render + JS-execution + neko-container CPU + screenshot overhead**, not by provider backpressure. The RTT signal AutoThrottle reads is buried under render noise; the prior SLVP doc rates this ~80% "may be too noisy to use as a graduated signal without a measured noise floor." So even the *latency* read that would make AutoThrottle-style probing possible is weak here.

2. **The objective is distribution-matching, not throughput** (Frame 1's decisive finding, corroborated by the Apify/Bright Data/Browserbase canon): the production browser platforms build behavioral simulation as a **separate layer** from rate-limiting/backoff. Layer 4 (behavioral timing) is a *floor-and-shape constraint* — `[humanFloor, humanCeiling]` with a log-normal-ish shape — **not** an optimization target. PerimeterX/HUMAN and DataDome key on *identical inter-request timing*, *zero scroll*, and event rate; a controller that AIMD-converges interval → minimum collapses variance to ~0 and is flagged *even while technically below any 429 threshold*, because the variance collapse — not the rate — is the tell.

**So the browser controller is a `BrowserEnvelopeGovernor` (name TBD) with three responsibilities, none of which is AIMD:**
- **(a) Typed per-action delay *distributions*** (not scalars): page navigation ~2–8s, form interaction ~0.5–2s, scroll gradual-with-pause — sampled, variance preserved as a first-class property. Replaces the hand-rolled `politeDelay(800)` / `politeDelay(4000)` constants the browser connectors scatter today.
- **(b) Session warmup sequencing** (homepage → category → target) — for session-cookie/behavioral-history reasons (Frame 1 Layer 3), not timing reasons.
- **(c) Challenge detection → hard backoff → handoff.** A CAPTCHA / re-auth / session-drop / empty-where-non-empty signal does NOT mean "increase interval and recover toward a ceiling." It means **re-establish session trust** (route to the existing `interaction_required` / `browser-handoff` / `credential-probe` pipeline) then re-enter. The corrective action is qualitatively different from AIMD backoff.

It still plugs into the **same seam** — `launchDelayHint: () => number` / one pre-flight wait — so the no-stacking doctrine holds and the `DETAIL_GAP` re-entry substrate is shared. The *internal logic* is distribution-maintenance, not rate-AIMD. That is precisely "shared scaffold, different controller."

**The honest caveat:** if empirical measurement (the ~80% open question) shows the neko path *can* surface a reliable graduated trust signal, the browser controller's signal layer gets richer — but its *objective* (maintain-distribution, respect-floor, never-converge-to-min) does not change, so it never becomes AIMD. The verdict is robust to that measurement.

---

## 4. THE IMPLEMENTATION PLAN

### Phase A — API runtime-capability hoist (NOT in doubt; spec it)

**Outcome:** the 6 API connectors + every new API connector inherit slow-start, warm-start, and `collection_rate` observability *by default*, from the runtime, with no per-connector wiring.

**Files:**
- `packages/polyfill-connectors/src/runtime-capabilities.ts` — extend beyond placement: the runtime that satisfies a connector's bindings also constructs its `SendGovernor`. Add a `provisionGovernor(profile, manifestCollectionProfile)` half to the contract.
- `packages/polyfill-connectors/src/connector-runtime.ts` — add `sendGovernor: SendGovernor` to `BaseCollectContext` (`:106`); the runtime builds it in the `baseCtx` assembly (`:686`) from the manifest. Default for network-only bindings = `ProviderPacing`-backed governor with a **non-zero** conservative `initialIntervalMs` (the current default-0 makes fastest-safe *opt-out*; flip it to *opt-in-to-faster*).
- **Extract the warm-start helper** out of `connectors/chatgpt/index.ts` (`readChatGptPersistedPacing` / `resolveChatGptWarmStartInterval` / `buildChatGptPacingStateFields`, ~50 lines, generic except the STATE key namespace) into a shared `pacing-warm-start.ts` parameterized by state-key. The runtime calls it to seed `restoredIntervalMs` from `ctx.state` and to persist `snapshot()` after the run.
- **Auto-emit `collection_rate`** progress from the runtime using the already-defined `CollectionRateProgress` in `connector-runtime-protocol.ts` — connectors stop hand-emitting it.
- The 6 connectors (`github/notion/oura/spotify/strava/ynab`): **delete** the per-connector `createConnectorHttpGovernor` call; they receive `ctx.sendGovernor` instead. Net: each connector *loses* a line, gains AIMD + warm-start + observability.
- `connectors/reddit/index.ts` — adopt `ctx.sendGovernor` in place of the hand-rolled `politeDelay(500)` page delay + manual `reddit_rate_limited` throw.

**New connector-author experience (the one-liner):** *"To add an API connector you declare `collection_profile: { modality: network, interval_ceiling_ms: <safe value> }` in the manifest and `await ctx.sendGovernor.acquire()` before each request. Slow-start, warm-start across runs, Retry-After honor, `<name>_rate_limited` cross-run deferral, and `collection_rate` progress are automatic. Fastest-safe is the default; you only ever set the ceiling."*

**Effort:** **M.** The hard parts (`ProviderPacing` GCRA+AIMD, `retryHttp`, `SendGovernor` doctrine, `PreflightWaitProbe`, the warm-start pattern, `CollectionRateProgress`) all exist and are tested. This is plumbing + one ~30-line helper extraction + flipping a default + a manifest field. The behavioral risk is low because the loop body is unchanged; what moves is *who constructs it*.

### Phase B — Browser generalization (the verdict says NOT the same loop → scoped browser-pacing design, not a forced merge)

**Outcome:** browser connectors (`amazon/chase/usaa`, ChatGPT-via-neko) get a human-envelope governor as a zero-config runtime default, replacing scattered `politeDelay` constants.

**Files:**
- New `packages/polyfill-connectors/src/browser-envelope.ts` — `BrowserEnvelopeGovernor`: per-action sampled delay distributions, session-warmup sequencing, challenge-detection → handoff. Implements `SendGovernor` (so it slots the same seam) but its body is distribution-maintenance, not AIMD; exposes `launchDelayHint` for the lane.
- `connector-runtime.ts` — `BrowserCollectContext` (`:132`) inherits `sendGovernor` from the base; the runtime constructs the *envelope* variant when bindings include `browser`. Wire challenge signals into the existing `interaction_required` / watchdog path (`SessionCheckpointFn`, `ensureSession`).
- `connectors/{amazon,chase,usaa}/index.ts` — replace `politeDelay(800)` / the 4000/5000/6000ms settle constants with `ctx.sendGovernor` per-action samples (keep `waitForSelector` as the real DOM-sync primitive; the governor adds the *human-shaped variance between* actions, not instead of DOM waits).

**New connector-author experience:** *"To add a browser connector you declare `collection_profile: { modality: browser, action_delays: {...optional overrides...} }`. The runtime injects a human-envelope governor: navigation/dwell/scroll timing is sampled from human-plausible distributions, session warmup is sequenced, and a CAPTCHA/re-auth/session-drop signal routes to owner handoff automatically. You do NOT tune throughput; variance is preserved for you."*

**Effort:** **L** — not because the seam is hard (the `launchDelayHint` slot and `BrowserCollectContext` injection point are trivial) but because **calibrating the human envelope is research debt the API path skips by delegating to the provider's 429**: what inter-navigation distribution looks human per site, which signals reliably distinguish a soft challenge from a transient DOM delay (the ~80% open question), and the irreversible-failure cost that forbids probe-the-ceiling discovery. Phase B is gated on that calibration, not on the plumbing.

**Sequencing:** Phase A ships independently and immediately (it is pure consolidation of already-proven machinery). Phase B is a separate primitive on the same seam; it does not block A and A does not block it. Do **not** merge them into one governor type.

---

## 5. WHAT STAYS GENUINELY OWNER'S-CALL

These are priors and policy, not research outputs — the design fixes the *shape*, the owner fixes the *values*:

1. **The API safety-ceiling value** (`minIntervalMs`, the fastest interval AIMD may reach). Set *below the estimated behavioral-flagging threshold*, not merely below the observed 429 threshold. Per-provider. (Carried over from the prior SLVP verdict, which explicitly excludes the ceiling value from its confidence claim.)
2. **The browser human-envelope band per site** — the `[humanFloor, humanCeiling]` and distribution shape for navigation/dwell/scroll. This is empirical + risk-tolerance, not derivable; it is the core of Phase B's research debt.
3. **Whether to invest in the latency/behavioral-challenge graduated signal at all** (the ~80% question), or ship Phase B with a binary challenge-detector only. Measuring the neko-path noise floor is the precondition; whether it's worth measuring is owner's-call.
4. **Flipping the API default from opt-in (interval 0) to a non-zero conservative slow-start** — a behavioral change to the 6 live connectors' pacing. Safe in shape, but it changes live collection velocity, so it is the owner's go.
5. **Per-connector throughput vs. ban-risk tolerance** — e.g. how aggressive ChatGPT's documented bounded-run caps are. The governor enforces whatever envelope it's given; the envelope's aggressiveness is a product decision.
6. **Reddit / unmigrated-connector adoption order** — which hand-rolled connectors get hoisted onto `ctx.sendGovernor` first.

---

## Appendix — frame reconciliation (where the three frames agree and where they add)

- **All three frames independently reach "two controllers, one seam."** Frame 1 from *practice* (production platforms build behavioral simulation as a separate layer from rate-limiting). Frame 2 from *control-theory* (the objective layer diverges in sign; AIMD's increase-on-success is structurally wrong for browser; "incidental-complexity trap in reverse"). Frame 3 from *code* (the `launchDelayHint`/`SendGovernor` seam is genuinely transport-agnostic and shared; the AIMD loop body is not reusable; `BrowserCollectContext` has no governor field). Triangulated convergence is why confidence is 97%, not 80%.
- **Frame 1 supplies the decisive *why*:** the browser objective is variance-preservation inside `[floor, ceiling]`, and convergence-to-minimum (what AIMD does) collapses variance and is itself the fingerprint — independent of any rate threshold.
- **Frame 2 supplies the decisive *mechanism*:** the sign of the control action on a clean success differs (API decreases interval; browser must not), so it is not "same loop, different parameters."
- **Frame 3 supplies the decisive *seam and cost*:** the shared surface is `launchDelayHint` + the gap substrate (both built); Phase A is **M** (plumbing + helper extraction + default flip), Phase B is **L** (research debt on envelope calibration, not seam difficulty); the `BrowserCollectContext` injection point exists but is empty.
- **Prior SLVP doc** ([`slvp-adaptive-collection-ideal-2026-06-11.md`](./slvp-adaptive-collection-ideal-2026-06-11.md)) already settled the API single-loop at 96%; this doc *extends* it to the generalization fork and does not relitigate the API loop.
