# Wall-clock / session bound in the SLVP-ideal collection design — FINAL VERDICT

**Date:** 2026-06-11
**Status:** Closed. This is the defended, final answer. The owner should not have to re-ask.
**Scope:** Does the SLVP-ideal "fastest-safe, lose-nothing" collection design for ChatGPT include a per-run wall-clock / session-duration bound as an **essential** safety component, or is that bound **incidental**?

**Corpus grounded in shipped code:**
`packages/polyfill-connectors/src/run-budget.ts` (the `RunBudget` class),
`packages/polyfill-connectors/connectors/chatgpt/index.ts` (the budget design comment L266–298, the rate-ceiling comment L320–327, the env resolvers L358–419, the warm-start L505–582, the circuit wait-out guard L330–348, the defer call site L2765–2814, drain-within-budget recovery L3060–3131),
`packages/polyfill-connectors/manifests/chatgpt.json` (refresh policy L22–33),
`reference-implementation/runtime/scheduler-source-pressure-cooldown.ts` (cross-run cooldown, 6h cap L80, reason-gated L49–53),
and the prior attack-resolved design memo `docs/research/slvp-adaptive-collection-ideal-2026-06-11.md` (§3 item 5: `RunBudget` is "Watch, not delete").

---

## 1. THE VERDICT

**Position B — INCIDENTAL — at 90% confidence.** The SLVP-ideal fastest-safe design contains exactly **one** authored safety number: the rate ceiling (`PDPP_CHATGPT_PACING_MIN_INTERVAL_MS`, default 250ms — the single fixed prior the controller never crosses, L320–327). A correctly-specified AIMD controller bounded by that ceiling, over a finite work queue with a lose-nothing durable-gap substrate, has a **structural** completion (work drained → stop) and needs no clock to be safe. The per-run wall-clock cap (`PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS`) and detail-fetch cap (`PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN`) are **opt-in owner/system envelopes, default `Infinity`, off by default** — the connector's own design comment says so verbatim: *"Size/time caps are explicit owner/system envelopes only; they are not the default throttle"* (L297–298). They are not part of the safety envelope; they are an operational convenience for unattended scheduling plus a pathology backstop. The compounding-runs behavior the owner correctly observes is **real and is the operational model**, but it is produced by the durable `DETAIL_GAP` substrate + the scheduler cadence + the density-stop on real 429 pressure — **not** by the wall-clock cap. A run with both caps at their default `Infinity` already syncs to 100% safely. This is exactly the classification the prior attack-resolved memo reached independently: `RunBudget`'s *only* essential property is reason-discrimination (`run_cap_deferred` must not arm the cross-run cooldown); its *existence as a stop* is "borderline-incidental scaffolding" (slvp-ideal §3 item 5).

**Why 90% and not 99%, and the one fact that closes the gap:** The residual 10% is the single empirically-unmeasurable question — *does OpenAI's account-protection layer apply a session-continuity / session-duration anomaly signal that fires independently of per-request rate and cumulative volume?* If it does, then a human-plausible session-length bound becomes a **second** authored behavioral-safety number (Position A's strongest form), because rate and session-duration are then orthogonal detection axes. If it does not, B is unqualified. This cannot be settled without probing ChatGPT's classifier, and probing risks the account — which violates the SLVP doctrine that the safety ceiling cannot be discovered by probing. **The single fact that would close the gap to 99%:** a characterization of whether ChatGPT flags long continuous authenticated sessions at a fixed per-request rate (e.g., an observed account warning or rate-shift correlated with session duration but not with request rate). Absent that fact, the manifest's `bot_detection_sensitivity: "high"` is a reason to keep the session-bound *available as a knob* — but availability of an opt-in knob is precisely Position B, not Position A.

---

## 2. THE DIRECT ANSWER TO THE OWNER

> *"If I rerun ChatGPT, will it sync 100% of my data no matter how rate-limited I am?"*

**Yes — across auto-resuming runs, each one a safe bounded session, with zero further action from you after the initial browser auth; on a small/already-warm account it finishes in a single run, and on a large cold account it converges to 100% over successive scheduled runs because every run recovers the prior run's deferred gaps first, then walks forward, and nothing is ever lost.**

(One-run-to-100% is the normal case for an account whose backlog fits inside one run; the multi-run drain is the worst-case for a large cold account or one under sustained throttling. Either way the terminal state is 100%.)

---

## 3. THE EXACT DESIGN

**Authored numbers: ONE.** The rate ceiling `minIntervalMs` (default 250ms; `PDPP_CHATGPT_PACING_MIN_INTERVAL_MS`). That is the only behavioral-safety prior — set below the operator's estimated flagging threshold, never crossed, never discovered by probing (index.ts L320–327; slvp-ideal §6 item 1). Everything else is a derived horizon or an AIMD shape.

The wall-clock cap and fetch cap are a **second, optional** number the owner *may* author for the unattended case. They are not part of the minimal safe design. With them unset (the default), the design is complete and safe.

**What stops a run** (in the ideal, default-configured design):

1. **Work drained.** The forward walk lists no new conversations and the gap backlog is empty → run completes at 100%. This is the structural terminal condition; it needs no timer.
2. **Real source pressure (the density stop).** When the account serves enough 429s in a window (`CHATGPT_RATE_LIMIT_DENSITY_STOP_DEFAULT = 8`, L205), the connector defers the remaining tail as durable `upstream_pressure` `DETAIL_GAP` records and exits. This *is* a safety stop — but it is triggered by the provider's signal, not a clock. It arms the cross-run cooldown so the next scheduled run waits.
3. **(Opt-in only) the run cap.** If — and only if — the owner sets a wall-clock or fetch cap, `maybeDeferForRunBudget` (L2765) trips `runBudget.reason()`, emits a `PROGRESS` event, and folds the remaining tail into resumable `run_cap_deferred` gaps (L2780). This reason is deliberately *distinct* from `upstream_pressure` so it does **not** arm the cooldown governor (L287–293) — a capped run is not a hot provider.

**The pathology guard (so it can never spin forever on a near-zero-but-nonzero throttle):** This is the failure mode Position A's best technical attack names — a provider that serves every request successfully (HTTP 200, no 429, no circuit trip) but throttles to, say, 1 req / 10 min, so a single run would take 40+ hours while making genuine forward progress. The correct instrument is **not** a wall-clock cap (which also fires on a healthy-but-slow run); it is the **forward-progress guard on the circuit wait-out loop**, `CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES = 8` (L330–348): a circuit that keeps re-opening (provider genuinely hostile, not transiently busy) converges to a durable defer after a bounded number of cool-down waits instead of looping forever within budget. The remaining slow-but-successful-crawl case is bounded by the **scheduler cadence**: the next scheduled run boundary is itself the natural session break; the in-progress run's hydrated prefix has already committed its cursor, so a slow run that is interrupted by the next dispatch loses nothing. A wall-clock cap is a coarser proxy for this — redundant with the progress guard for the pathological case and harmful (it fires on healthy slow runs) for the normal case.

**How 100% is reached:** By the durable `DETAIL_GAP` substrate + scheduler compounding, regardless of caps. Each run: (a) recovers prior gaps first via drain-within-budget (L3060–3131), emitting `DETAIL_GAP_RECOVERED` for each hydrated key; (b) commits its cursor only over the hydrated prefix; (c) writes new gaps for whatever it deferred. The next run picks up exactly there. The backlog converges monotonically to zero. The manifest declares `recommended_mode: "automatic"`, `assisted_after_owner_auth: true`, `minimum_interval_seconds: 3600` (L23–32), and the warm-start path (L505–582) persists the AIMD-learned interval across runs within a 6h staleness window, so successive runs resume *faster* at the learned rate rather than cold-starting.

**Does the owner have to do anything?** **No** — after the initial browser authentication, with the scheduler enabled the runs happen automatically, the backlog drains, and the question is permanently closed. The only thing the owner authors is the *one* rate-ceiling number (and it has a safe default of 250ms). The owner does **not** need to author a wall-clock cap for correctness or safety.

---

## 4. THE IMPLEMENTATION DELTA FROM WHAT IS SHIPPED TODAY

**Verdict: KEEP-but-reframe. Do not remove the caps; do not promote them to safety-tier invariants. Reclassify them in code and docs as opt-in operational/pathology envelopes, default-off, NOT the safety lever.**

This is the smallest, safest delta and it matches what the code already does — the gap is in *framing and emphasis*, not in behavior. Today's code is already B-shaped (caps default `Infinity`, "not the default throttle"). The delta hardens that classification so the question stops recurring.

- **`packages/polyfill-connectors/src/run-budget.ts`** — no behavioral change. Optionally tighten the class docstring (L12–17) to state the run is *normally* terminated by work-drained or density-stop, and `RunBudget` is the **opt-in** envelope for the unattended case, never the default safety bound. (Per slvp-ideal §3 item 5 / §6 item 4, whether `RunBudget` stays a class or collapses to a run-level abort signal is a maintainability preference, not a correctness question — leave the class; it works.)

- **`packages/polyfill-connectors/connectors/chatgpt/index.ts`** — keep `resolveChatGptMaxDetailFetchesPerRun` / `resolveChatGptMaxRunWallClockMs` (L358–387) exactly as-is (both already return `Infinity` when unset). The new run-termination logic is **already correct** and needs no change: `maybeDeferForRunBudget` (L2765) only trips when an owner opted in; the structural terminal (work-drained) and the density-stop already stop the default run. The one thing to *confirm and pin with a test* is that the slow-but-successful-crawl pathology is bounded by `CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES` (L343) and the scheduler boundary — not silently dependent on someone having set a wall-clock cap. If a forward-progress guard for the *non-circuit* slow-crawl case is wanted (zero hydrations in N minutes → defer), add it as a small explicit guard rather than leaning on the wall-clock cap; this is the only candidate *new* code, and it is optional.

- **`reference-implementation/runtime/scheduler-source-pressure-cooldown.ts`** — no change. The essential property — `run_cap_deferred` gaps do **not** appear in `SOURCE_PRESSURE_GAP_REASONS` (L49–53) and so do not arm the cooldown — is the one non-negotiable correctness invariant and is already correct. This is the *only* part of the run-budget machinery the slvp-ideal memo marks as essential.

**Net:** zero required behavioral changes; reframe the caps as opt-in envelopes in docstrings; optionally add an explicit no-forward-progress guard for the slow-successful-crawl case so the wall-clock cap is never the load-bearing stop. The caps stay because they are a *cheap, strictly-safer* unattended-scheduling convenience ("a single nudge could turn into an unbounded run" on a huge cold account when no owner is watching, L272–274) — but they are demoted from "safety invariant" to "owner/system envelope," which is what the code already says and what this verdict makes permanent.

---

## 5. HOW TO PROVE IT LIVE

Two demonstrations. The owner watches the backlog go to zero with **no** wall-clock cap set, proving the caps are not what reaches 100%.

**Proof A — one run to 100% (small/warm account):**
1. Confirm the account is cold-or-warm and no run is active (owner `GET /_ref/connections/<id>` → `RuntimeProjection` shows no active run).
2. Ensure `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS` and `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN` are **unset** (default `Infinity`). Optionally set the one authored number `PDPP_CHATGPT_PACING_MIN_INTERVAL_MS=250` explicitly to make the ceiling visible.
3. Trigger one manual `Sync now`.
4. Observe: the run lists conversations, hydrates details at the AIMD-paced rate, and terminates with **zero** pending `DETAIL_GAP` records. The health projection shows `idle` / fresh. 100% in one run, with no cap involved.

**Proof B — N runs draining a gap backlog to zero (large cold account, the worst case):**
1. Same preconditions; caps still unset.
2. Trigger run 1. On a large account it will hit the density stop (real 429 pressure) or simply not finish the full history in one sitting; it commits the hydrated prefix's cursor and writes `DETAIL_GAP` records (`upstream_pressure` if pressured) for the tail. Record the pending-gap count `G1` (via owner `GET /_ref/connections/<id>` or the spine events).
3. Let the scheduler dispatch the next run (or trigger manually after the cooldown), spaced ≥ `minimum_interval_seconds` (3600s) — or immediately by manual `Sync now`, which bypasses the cooldown.
4. Each subsequent run recovers prior gaps first (`DETAIL_GAP_RECOVERED` events), commits, and defers a strictly smaller tail. Record `G2 > G3 > ... → 0`. The backlog converges **monotonically** to zero across runs.
5. When the pending-gap count reaches 0 and the forward walk lists nothing new, the connector is at 100%. Nothing in this sequence used a wall-clock cap — it was the durable-gap substrate + scheduler cadence + warm-started AIMD pacing.

**What the proof demonstrates:** 100% is reached by compounding bounded runs driven by the gap substrate and the *one* rate ceiling — not by a session/wall-clock bound. The wall-clock cap, if the owner ever sets it, only makes an individual run stop *earlier* and defer *more* to the next run; it never changes the terminal 100%. That is the definition of incidental.

---

## Appendix: the two adversarial attacks, resolved explicitly

**Attack 1 — the flip-it technical attack ("rate and session-duration are orthogonal detection axes; a 6h run at 2 req/min is innocuous on rate but anomalous on a behavioral-accumulation classifier (PerimeterX/HUMAN delayed enforcement); `bot_detection_sensitivity: high` is the design team's own encoding of exactly that risk; therefore the session bound is a SECOND essential safety number → A").**

*Resolution: the attack is the strongest case for A and it moves the confidence (it is why this is 90%, not 99%), but it does not flip the verdict, for three reasons.* (1) It is an **absence-of-evidence-cuts-both-ways** argument resting on an *unmeasured* premise — that OpenAI applies a session-continuity signal that fires independently of rate and cumulative volume. No public anti-bot vendor documents a wall-clock session-duration *threshold*; every source that names "session length" lists it as one composite-model input alongside rate and behavioral signals, not a standalone trigger (Frame 1). `bot_detection_sensitivity: high` justifies keeping the bound **available as an opt-in knob** — which is Position B's own conclusion (the caps stay, off by default). It does not justify making the bound a *default* safety invariant the owner must author. (2) Even granting the orthogonality, the correct lever for "long continuous sessions are suspicious" is the **scheduler cadence and session break between runs** (the manifest's `minimum_interval_seconds` and the compounding-runs model), which already exists and already produces human-plausible bounded sessions — not a connector-internal wall-clock cap. The bounded-runs *operational model* (which the attack and Frame 3 correctly champion) is **already the design**; it is produced by the scheduler + gap substrate, so conceding "bounded runs that compound" does *not* concede "the connector needs an essential wall-clock cap." (3) The attack's own framing — "an authored safety number of the same class as the rate ceiling, owner-configurable, not derivable from first principles" — **is Position B's classification.** An opt-in owner-risk knob that is off by default is incidental to the minimal safe design by definition. The verdict therefore absorbs the attack: keep the bound available for the `bot_detection_sensitivity: high` owner who wants human-plausible session lengths, default it off, and never call it a safety invariant.

**Attack 2 — the owner-mental-model attack ("the owner wants 'I don't want to keep asking'; (A)-with-scheduler is lowest friction and (B)'s single unbounded run looks like a hang on a large account, so the design that serves the owner is bounded compounding runs → A").**

*Resolution: this attack is correct about the operational model and wrong about what it implies for the wall-clock cap's classification.* "I don't want to keep asking" is served by **the scheduler running bounded compounding runs with zero owner nudging after auth** — which this verdict fully endorses and is the literal content of §2 and §5 Proof B. But that model is delivered by the **gap substrate + scheduler cadence + density-stop**, none of which is the wall-clock cap. The "unbounded run looks like a hang" concern is real *only* on a large cold account with no owner watching, and the connector's own comment (L272–274) names exactly this as the reason the *opt-in* envelope exists — *for the unattended case*, "not the default throttle." So the owner-mental-model attack vindicates **bounded compounding runs** (which is the operational model, Position-A-flavored in *operation*) while leaving the **wall-clock cap's classification as incidental/opt-in** (Position B in *the minimal safe design*) untouched. The synthesis the owner should hold: *the operational experience is bounded compounding runs that drain to 100% with no nudging; the safety design underneath has exactly one authored number (the rate ceiling); the wall-clock cap is an optional unattended-scheduling convenience, not the thing that keeps you safe and not the thing that gets you to 100%.* Both attacks, fully honored, land on the same place: **B, with the bounded-compounding-runs operational model intact.**
