# Provider Rate Governance Convergence

Status: captured
Owner: reference implementation owner
Created: 2026-06-10
Related:
- `docs/research/client-rate-governance-prior-art-2026-06-10.md` (six-system survey; sources inside)
- `tmp/workstreams/rate-governor-inventory-2026-06-09.md` (code-level inventory of AdaptiveLane, ProviderPacing, scheduler governors, per-connector 429 handling)
- `openspec/changes/add-provider-budget-run-control/` (8 of its 12 open tasks belong to this convergence)

## Question

Which component owns provider rate-control when the ChatGPT 429-handling work
is generalized to all connectors — and how do the existing pieces (AdaptiveLane,
ProviderPacing, retryHttp, scheduler pressure cooldown) compose without
double-delay stacking?

## Context

The inventory found two potential send governors over the same upstream:
AdaptiveLane (concurrency AIMD + jittered launch delays; live-calibrated on
ChatGPT, the only provider that has actually rate-limited us) and
ProviderPacing (GCRA + rate-AIMD; wired behind an off-by-default env var,
never calibrated live). Their delays stack additively today by intentional
cold-start conservatism. Seven other connectors hand-roll `429 → throw` with
no Retry-After handling.

The prior-art survey (AWS adaptive retry, Netflix concurrency-limits, Envoy
adaptive concurrency, Google SRE client throttling, Scrapy AutoThrottle, GCRA
practice, Finagle retry budgets, Temporal worker limits) converges on a
three-layer doctrine:

1. **Retry budget** — decides WHETHER a failed request may retry at all
   (Finagle's ~20% ratio cap prevents retry storms).
2. **One send governor** — gates pre-flight send velocity: rate OR concurrency
   as the primary, never both as independent gates (Temporal documents the
   two-independent-gates setup as an explicit anti-pattern).
3. **Backoff** — decides WHEN a specific failed request re-enters; fires
   after a failed send, never inside the same pre-flight wait loop as layer 2.

Decisive finding: **GCRA is a smoothing primitive for known quotas, not a
discovery primitive.** For unknown-quota providers — all of ours — the
self-calibrating choices are AIMD discovery or latency-driven concurrency
limits (Gradient/Vegas). Scrapy AutoThrottle, the closest analog to polite
browser-automation collection, is latency-driven target concurrency.

## Current Leaning (supersedes the 2026-06-09 in-session leaning)

The earlier leaning — "ProviderPacing owns rate; AdaptiveLane keeps
concurrency with launch delay zeroed" — is the inverted form of what the
prior art supports. Corrected:

- **The concurrency lane is the sole pre-flight send governor**, promoted from
  ChatGPT-local AdaptiveLane into a shared connector-runtime primitive. It is
  both the doctrinally right governor for unknown quotas and the only
  live-calibrated one we own.
- **ProviderPacing's GCRA does not run as an independent gate.** If smoothing
  is wanted once a provider's quota becomes known (e.g. a documented API
  limit), GCRA becomes a signal/component INSIDE the shared governor — one
  gate, two signal inputs — or is retired.
- **Retry-After honor and the double-pay guard (`retryAfterAlreadySlept`) live
  in the retry layer** (`retryHttp`), which all connectors should adopt; add a
  Finagle-style retry budget there. Backoff stays post-failure only.
- **Scheduler-side pressure cooldown remains the cross-run layer** (already
  cleanly separated; `SOURCE_PRESSURE_GAP_REASONS` vs budget-exhaustion
  discrimination must be preserved).
- The seven hand-rolled `429 → throw` connectors adopt the shared governor +
  retryHttp instead of growing local fixes.

## Gates

- Final ownership decision and any parameter changes are gated on **live
  calibration during/after the ChatGPT workstream finishes** — the only
  upstream that exercises the governor for real. Do not start the convergence
  lane before then.
- Disposition of `add-provider-budget-run-control`'s 12 open tasks: 8 fold
  into this convergence, 3 are independent, 1 straddles (per the inventory).
  Update or supersede that change when the convergence lane opens.

## Decision Log

- 2026-06-10: Captured after the prior-art survey contradicted the in-session
  leaning. Lesson recorded: a structurally sound recommendation (one governor,
  no stacking) can still pick the wrong owner without prior art — the research
  step changed which primitive survives.
