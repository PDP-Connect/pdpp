# Proposal: converge-provider-rate-governance

## Why

The ChatGPT 429-handling work produced a battle-tested rate stack
(`AdaptiveLane` concurrency governor, `ProviderPacing` GCRA bucket, `retryHttp`
with Retry-After honor, `ProviderBudgetController` composing run budget + retry
budget + circuit breaker). But the doctrine for *who owns rate control when this
is generalized to all connectors* was never specified, and the live composition
drifted into the anti-pattern the prior art warns against.

Two surveys settled the doctrine
(`docs/research/client-rate-governance-prior-art-2026-06-10.md`,
`design-notes/provider-rate-governance-convergence-2026-06-10.md`): a request
path to one provider must have a **three-layer** model with exactly **one**
pre-flight send governor. Deploying both a concurrency governor and a GCRA
rate governor as independent pre-flight gates over the same upstream is the
Temporal / Google-SRE-documented anti-pattern — their waits compound.

Two concrete problems this change fixes:

- **Latent double-gate.** `ProviderBudgetController.beforeRequest()` performed
  its own pre-flight `await pacing.admit()`. The ChatGPT path mitigated stacking
  only by *zeroing the adaptive lane's launch delay* whenever a pacing
  controller was present — the inverted ownership the prior art rejects (the
  concurrency lane should be the governor; GCRA a signal). Any future code that
  reintroduced a lane launch delay alongside the controller's pacing wait would
  silently stack two pre-flight waits. The shape made the mistake easy to
  express.
- **Seven connectors with no inline rate handling.** GitHub, Reddit, YNAB,
  Notion, Strava, Oura, and Spotify hand-rolled `if (status === 429) throw
  "<name>_rate_limited"` with **no Retry-After honor** and **no retry budget**,
  leaning entirely on the cross-run source-pressure cooldown. They duplicated
  the throw-and-defer shape and could not honor a server's `Retry-After`.

This change establishes the layer-ownership doctrine as normative requirements,
makes a second pre-flight gate hard to express, and migrates the API connectors
onto the shared primitives.

## What Changes

- **Send-governor boundary (`SendGovernor`).** A request path takes exactly one
  `SendGovernor`; `acquire()` is the only sanctioned pre-flight wait. There is
  deliberately no combinator that sequences two governors — composing two
  pre-flight waits is not expressible through the interface. A
  `PreflightWaitProbe` test seam counts wait sources so stacking is detectable.
- **GCRA demoted from a gate to a signal.** `ProviderPacing` gains a pure
  `nextDelayMs()` (computes the owed delay, advances GCRA state, does not
  sleep). `ProviderBudgetController` gains `pacingMode`: `"preflight"` (default,
  byte-identical — controller owns the wait) or `"signal"` (converged —
  controller performs no pre-flight wait and exposes `pacingDelayHint()` for the
  single governor). The adaptive lane gains a `launchDelayHint` that folds the
  pacing delay into its one launch wait as `max(launchDelay, cooldown, hint)`,
  never a sum.
- **Retry layer.** `retryHttp` keeps Retry-After honor (with the existing
  double-pay guard: the server interval is slept once, never stacked on backoff)
  and gains an optional Finagle-style ratio-based retry budget hook
  (`HttpRetryBudget`). A shared `createConnectorHttpGovernor` wraps `retryHttp` +
  one `SendGovernor` and preserves each connector's `<name>_rate_limited`
  terminal throw so the cross-run cooldown contract is unchanged.
- **Connector migration.** The six native-`fetch` API connectors (GitHub, YNAB,
  Notion, Strava, Oura, Spotify) adopt the shared governor with
  `maxAttempts: 1`, keeping the immediate-throw behavior byte-identical while
  wiring Retry-After honor behind that one knob. Reddit (browser-transport) and
  Amazon (p-retry + year-partition state) are documented out-of-scope (see
  `design.md`).
- **ChatGPT convergence behind a default-off flag.** The default keeps today's
  controller-owned pacing wait byte-for-byte. `PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE`
  flips the controller to `"signal"` mode so the adaptive lane becomes the sole
  send governor with pacing as a launch-delay signal. Parity is proven by golden
  tests (same decisions, exactly one pre-flight wait source, equivalent total
  wait). The flip is owner-gated on live calibration — the one open terminal
  task.
- **Disposition of `add-provider-budget-run-control`.** That change's
  rate-governance axes are absorbed here (run budget, retry budget, circuit
  breaker, pacing, detail-gap drain). It is marked **superseded** so only one
  change carries the `polyfill-runtime` rate-governance deltas to archive. Its
  three independent tasks (checkpoint durability, catch-up/steady-state
  bookmarks) and its one straddling task (operator display copy, owned by
  `apps/console`) are listed as out-of-scope notes in `tasks.md`.

## Capabilities

Modified:
- `polyfill-runtime`

Added:
- None

Removed:
- None

## Impact

- Collection Profile runtime authoring policy only. No change to the public
  `/v1` API, grant semantics, manifest schema, JSONL wire format, or the
  operator dashboard wire contract.
- ChatGPT default behavior is byte-identical (the convergence path is
  default-off, gated on `PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE`).
- The six migrated API connectors default to `maxAttempts: 1` — their
  rate-limit-throw behavior and the `retryablePattern` cross-run cooldown
  contract are byte-identical; Retry-After honor is wired but inert until an
  owner raises `maxAttempts`.
- Supersedes `add-provider-budget-run-control`. The scheduler-side
  `SOURCE_PRESSURE_GAP_REASONS` discrimination (pinned by
  `scheduler-source-pressure-cooldown.test.js`) is preserved and now also pinned
  from the connector side by a reason-disjointness regression.
