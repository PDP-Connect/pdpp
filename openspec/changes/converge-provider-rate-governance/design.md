# Design: converge-provider-rate-governance

## Context

The rate machinery was already partly shared at the file level: `AdaptiveLane`
(`src/adaptive-lane.ts`), `ProviderPacing` (`src/provider-pacing.ts`),
`retryHttp` (`src/http-retry.ts`), `RunBudget` (`src/run-budget.ts`), and the
composing `ProviderBudgetController` (`src/provider-budget.ts`) all live in
`packages/polyfill-connectors/src/`, and ChatGPT consumes them. So the
"extract OUT of the ChatGPT connector" goal was structurally satisfied; the real
work was **establishing layer ownership** and **removing the double-gate**.

The decisive prior-art finding: GCRA is a *smoothing* primitive for known
quotas, not a *discovery* primitive. For unknown-quota providers (all of ours),
the self-calibrating governor is AIMD concurrency (the adaptive lane) or
latency-driven concurrency. So the concurrency lane — both the doctrinally right
governor and the only live-calibrated one — is the sole pre-flight send
governor. GCRA becomes a signal inside it or is retired.

### What the live code actually did (and the latent hazard)

`ProviderBudgetController.beforeRequest()` did `await this.pacing?.admit()` — a
pre-flight wait. The adaptive lane *also* has a pre-flight wait (its launch
delay + cooldown). ChatGPT avoided stacking them only by **zeroing the lane's
launch window** whenever a pacing controller was present
(`pauseMaxMs = pauseMinMs = 0`), making GCRA the sole wait. That is the inverted
ownership the prior art rejects: pacing owns the wait, the concurrency lane is
neutered. It works today at `maxConcurrency = 1`, but the shape made the
two-gate mistake trivial to reintroduce (restore a lane launch delay and you
have two stacked pre-flight waits).

## Layer Doctrine (normative — see spec delta)

1. **Retry budget (count).** Whether a failed request may retry at all
   (Finagle's ~20% ratio cap). Does not interact with rate or concurrency.
2. **One send governor (velocity).** Rate OR concurrency as the single
   pre-flight gate — never both independently. Fires *before* the send. For
   unknown-quota providers this is the AIMD concurrency lane; GCRA, if used,
   contributes a delay signal the governor folds in, it does not run its own
   gate.
3. **Backoff (delay).** When a specific failed request re-enters. Fires *after*
   a failed send, never inside the same pre-flight wait loop as layer 2.

Stacking two pre-flight waits over one provider is a spec violation (negative
scenario in the delta).

## Design Decisions

### D1. `SendGovernor` is the single pre-flight seam; two gates are not expressible

`SendGovernor.acquire()` is the only sanctioned pre-flight `await`. There is no
`compose(a, b)` combinator, no array of governors — a request path takes one
governor. The adaptive lane is the canonical implementation (its single launch
wait IS the gate). The decision layers (run budget, circuit breaker, retry
budget) are synchronous admit/deny or post-failure backoff, never a second
pre-flight wait. The `PreflightWaitProbe` test seam wraps each sleep site and
counts non-zero waits; the stacking regression asserts `count === 1` per
admitted request, and a paired detector test proves the probe *catches* the
two-gate anti-pattern (legacy preflight mode + a lane launch delay reads 2).

### D2. GCRA disposition — fold in as a signal, do NOT retire

**Recommendation: keep `ProviderPacing` (GCRA) as an internal smoothing signal
behind the governor's interface; do not run it as a second pre-flight gate, and
do not delete it.** Rationale:

- The design note's leaning is "GCRA becomes a signal/component INSIDE the
  shared governor — one gate, two signal inputs — or is retired." Folding in is
  strictly more capable than removal: when a provider's quota becomes *known*
  (a documented API limit), GCRA is the correct compliance primitive, and it is
  already live-wired for ChatGPT's cold-start interval. Removing it would
  discard a calibrated, tested component for no gain.
- The fold-in is mechanical and proven: `ProviderPacing.nextDelayMs()` computes
  the owed delay and advances the GCRA Theoretical Arrival Time *without
  sleeping*; `admit()` becomes exactly `sleep(nextDelayMs())` (byte-identical,
  pinned by the unchanged pacing suite). The controller in `"signal"` mode
  surfaces this via `pacingDelayHint()`; the lane folds it into its one launch
  wait as `max(launchDelay, cooldown, hint)`.
- Retirement would only be right if GCRA were dead weight. It is not: it is the
  live ChatGPT cold-start pacer. The git history reference is retained here in
  case a future owner does retire it: GCRA pacing was introduced by
  `f5fcc4cb feat(chatgpt): add adaptive provider budget pacing` and made a safe
  default by `9ad6d15b feat(chatgpt): use safe provider budget defaults`.

The one thing GCRA must NOT remain is a *second independent pre-flight gate* —
that is what `pacingMode: "signal"` removes.

### D3. The Retry-After double-pay guard, reproduced and re-fixed

The double-pay guard (`absorbedByRequestWait` in the lane,
`retryAfterAlreadySlept` in the controller) prevents paying a Retry-After wait
twice: once inside the request's retry sleep and again as a pre-flight
cooldown/pacing wait. While building `createConnectorHttpGovernor`, an early
version routed `Retry-After` into BOTH `retryHttp`'s sleep AND the pacing
bucket's `nextRetryAfterMs` override — and a unit test caught the resulting
`[7000, 7000]` double wait. The fix: on a retry, feed the pacing bucket the
throttle *signal* only (multiplicative fill-rate decrease), never the
Retry-After override — `retryHttp` already slept it. This is the same guard,
re-derived at a new call site, and is now pinned by a dedicated test.

### D4. Connector migration with `maxAttempts: 1` for byte-identical default

The seven hand-rolled connectors had no inline retry — a 429 threw immediately
and relied on cross-run cooldown. Adopting the shared governor with
`maxAttempts: 1` reproduces that exactly: one 429 exhausts immediately and
throws `<name>_rate_limited`, which still matches each connector's
`retryablePattern`, so the cross-run cooldown arms identically. The
Retry-After-honor + bounded-backoff capability is wired but inert until an owner
raises `maxAttempts` — a one-line opt-in, not a default behavior change. GitHub
is special: its rate-limit signal is `403 + x-ratelimit-remaining: 0`, mapped to
a synthetic 429 in `classify` so the uniform machinery applies.

### D5. ChatGPT convergence is default-off and parity-proven

`PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE` (default off) selects the controller's
pacing mode. OFF → `"preflight"` (controller owns the wait, lane delay zeroed) =
today byte-for-byte. ON → `"signal"` (lane owns the single wait, pacing folded
in as a hint, lane delay retained). The golden parity suite
(`connectors/chatgpt/convergence-parity.test.ts`) proves: same fetched IDs and
coverage (same decisions), exactly one pre-flight wait source per request, and
total wait within one launch-window of the legacy GCRA wait — never doubled.

## Disposition of `add-provider-budget-run-control`

That change is **superseded** by this one. Its rate-governance content is
absorbed here; only one change carries the `polyfill-runtime` rate deltas to
archive. Classification of its open work:

**Folds into this convergence (8 — rate-governance axes, already implemented):**
per-provider pacing (§2.1), retry budget (§2.2), circuit breaker (§2.3), run
budget envelope (§2.4), detail-gap drain loop (§2.8), circuit-transition
evidence emission (§2.7 first item), plus the live-calibration closeout (§3) and
the archive step (§3) — the calibration becomes the one open terminal task here.

**Independent (3 — not rate governance; stay with the superseded change or a
new lane):** checkpoint commit-gating/opaque-cursor/CI assertion (§2.5, three
items) and catch-up vs steady-state bookmark separation (§2.6). These are
cursor-durability concerns, orthogonal to send-velocity governance.

**Straddles (1 — out of scope here):** operator display copy distinguishing
budget-exhaustion from source-pressure deferrals (§2.7) lives in `apps/console`,
which this lane must not touch. The *data-layer* discrimination it depends on
(budget reasons disjoint from `SOURCE_PRESSURE_GAP_REASONS`) is in scope and is
pinned here by a new regression; only the UI copy is deferred.

## Out of Scope (connectors)

- **Reddit** — fetches through `page.evaluate` (browser transport) and injects
  its `RedditListingFetch` for tests; its rate-limit check is a parsed-status
  branch in `paginate`, not a `fetch` call. Adopting the governor means wrapping
  the injected fetch seam, which would alter the integration-test contract.
  Deferred: the shared governor is transport-agnostic, so a later lane can adopt
  it, but it is higher-risk than the uniform native-fetch connectors and has no
  live 429 to validate against.
- **Amazon** — uses `p-retry` directly with `AbortError` and a year-freezing
  incremental strategy entwined with year-partition cursor safety. Migrating it
  risks the cursor-safety invariants for low rate-governance gain (Amazon's
  null-detail paths are nav/parse failures, not 429s). Deferred with this
  rationale per the task's "migrate if low-risk, else document why."

## Risks and Tradeoffs

- **Converged ChatGPT timing is equivalent, not bit-identical.** In `"signal"`
  mode the lane takes `max(launchDelay, pacingHint)` rather than the controller
  sleeping the pacing interval; with a single in-flight request and a launch
  delay below the pacing interval, the GCRA interval dominates and velocity
  tracks the same bucket. The parity suite bounds it (≥ legacy, < 2× legacy).
  Because it is not provably bit-identical, the flip is default-off and
  owner-gated on live calibration — the one open terminal task.
- **`maxAttempts: 1` leaves Retry-After honor inert by default** for the
  migrated connectors. This is deliberate: it preserves behavior. The capability
  is wired and tested; activating it is an owner knob.

## Acceptance Checks

- `SendGovernor` is the only pre-flight `await`; the stacking regression asserts
  exactly one pre-flight wait source per request, and the detector test proves
  the probe catches the two-gate anti-pattern.
- `ProviderPacing.admit()` is byte-identical to `sleep(nextDelayMs())` (pacing
  suite unchanged); `pacingMode: "preflight"` is the default and byte-identical.
- Retry-After is honored exactly with no double-pay (the server interval is
  slept once); the ratio-based retry budget caps retry volume and defers with a
  non-source-pressure reason.
- Each migrated connector's terminal rate-limit throws `<name>_rate_limited`
  matching its `retryablePattern`; with `maxAttempts: 1` a 429 makes exactly one
  provider call (byte-identical immediate throw).
- ChatGPT default (flag off) is byte-identical (147/147 chatgpt tests); the
  converged path makes the same decisions with exactly one pre-flight wait.
- Budget-exhaustion reasons are disjoint from `SOURCE_PRESSURE_GAP_REASONS`.
- `openspec validate converge-provider-rate-governance --strict` and
  `openspec validate --all --strict` pass.
