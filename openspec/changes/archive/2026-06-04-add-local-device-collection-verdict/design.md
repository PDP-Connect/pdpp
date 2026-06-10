# Design: local-device collection verdict

## Problem

`computeConnectionHealth` reaches `healthy` only when `isHealthyConditionSet` holds, which requires `CollectionSucceeded === "true"`. `collectionSucceededCondition` sets that to `true` only from `run.latestStatus === "succeeded"`. Local-device collectors write no spine run, so `run.latestStatus` is always `null`, `CollectionSucceeded` is always `unknown`, and the connection can never leave `idle`/`unknown` regardless of device evidence.

The `derive-local-collector-coverage-from-diagnostics` change already made the *coverage* axis honest for these connections and recorded the headline gap as an owner-gated residual:

> Headline state for a healthy drained local collector with complete coverage remains `idle` (no terminal collection verdict and freshness `unknown` without a `refresh_policy`); promoting it to `healthy` would require an ingest-as-collection-success signal, which is a separate contract decision out of scope here.

This change supplies that signal.

## What counts as a local-device collection-succeeded verdict

A scheduler-managed connector proves "collection succeeded" with a terminal spine run. The device-side analog is the device's own report that it ran and finished cleanly. Concretely, the verdict requires **all** of:

1. The connection is local-device-backed (`sourceKind === "local_device"`). Only the caller knows this; the classifier trusts the flag.
2. The outbox axis is `idle`, derived from **trusted** heartbeat evidence (active device, active source, not revoked). `idle` already means: a recent healthy/stopped heartbeat, no pending work, no dead letters, no stale leases, no backlog. `active`, `stalled`, and `unknown` do **not** qualify.
3. Durable coverage diagnostics prove `complete` coverage (every observed store accounted for; from `derive-local-collector-coverage-from-diagnostics`). `gaps`, `unknown`, or any degrading axis does **not** qualify.

A fourth gate, **freshness is `fresh`**, is applied at the same site. It is what keeps the change purely additive (see below): the verdict only fires for the fully-green case, so a drained-but-no-policy collector keeps its existing `idle` headline rather than flipping to `unknown`.

When all of these hold, the verdict sets `CollectionSucceeded = true` — exactly the condition a recent succeeded spine run would set. It is the honest claim that the device completed a current, complete collection cycle: it drained everything it had, accounted for every store it knows, and checked in within the freshness window.

## Why this is honest, not a false green

- **It is evidence-positive, not absence-based.** It fires only on the simultaneous presence of trusted idle outbox evidence AND durable complete-coverage records. An empty outbox with no coverage diagnostics keeps coverage `unknown`, so the verdict cannot fire (gate 3 fails) — the prior change's "empty outbox is not complete" guarantee is preserved end to end.
- **It cannot mask a degraded state.** The verdict only sets `CollectionSucceeded`. Every degrading condition (`LocalExporterAvailable=false` for a stalled outbox, `SourceCoverageComplete=false` for gaps, `BacklogClear` error, stale `Fresh`, open attention, blocked credentials/runtime) is computed independently and still wins via the ordered precedence — `classifyDegradedEvidence`, `classifyReadinessBlocked`, etc. all run before `classifyHealthy`. A stalled or gappy local collector is still `degraded`/`blocked`, never `healthy`.
- **It does not override run evidence.** When a spine run exists (`run.latestStatus !== null`), the run verdict is authoritative and the device verdict is ignored. A scheduler-managed connector's failed run cannot be papered over by device evidence, and a local connector that later gains run history defers to it.
- **It does not relax freshness; it requires it.** The verdict itself is gated on freshness `fresh` (a declared `refresh_policy` staleness window satisfied by a recent heartbeat). A local collector with no refresh policy has freshness `unknown`, so the verdict does not fire and the connection keeps its prior `idle` headline. The system genuinely cannot claim the data is fresh without a policy, so it does not. This is what makes the change purely additive: it only ever upgrades `idle → healthy` for the fully-green case, never `idle → unknown`.

## Net headline outcomes for a local-device connection

| Outbox | Coverage | Freshness | Headline (before) | Headline (after) |
|---|---|---|---|---|
| idle (trusted) | complete | fresh (refresh policy) | idle | **healthy** |
| idle (trusted) | complete | unknown (no policy) | idle | idle |
| idle (trusted) | gaps | any | degraded | degraded |
| idle (trusted) | unknown (no diagnostics) | any | idle/unknown | idle/unknown |
| stalled | any | any | degraded | degraded |
| active | any | any | (per other axes) | (unchanged) |
| unknown / untrusted | any | any | idle/unknown | idle/unknown |

Only the first row changes. Every honest non-green state is preserved.

## Where the gate lives

The classifier stays pure and source-kind-agnostic. It gains one optional evidence field, `localDeviceCollection: { verdict: "succeeded" } | null`, that the caller sets only after checking all four gates: local-device-backed (`localDeviceBacked === true`, derived by the caller from `sourceKind === "local_device"` on the list path or from the presence of trusted device heartbeats on the connector-keyed detail path), `outbox.axis === "idle"`, resolved `coverage.axis === "complete"`, and `freshness === "fresh"`. `collectionSucceededCondition` consults the verdict only when there is no run verdict (`run` absent or `latestStatus === null`). This keeps the classifier's "run is authoritative" invariant and confines the source-kind discrimination to the caller. The gate uses the *resolved* coverage axis from `buildCoverageEvidence` (which already prefers local coverage only when the run path is `unknown`), so a run-derived coverage gap is never masked.

## Alternatives considered

- **Establish the verdict without a freshness gate (verdict = idle + complete only).** Rejected. Without the freshness gate, a drained collector with complete coverage but `unknown` freshness would set `CollectionSucceeded = true` while `Fresh` stays `unknown`, and the classifier has no rung for that combination — it falls through to `unknown` (the same outcome the existing "succeeded run + complete coverage + unknown freshness" unit test asserts). That would turn the prior honest `idle` into a less-helpful `unknown`. Gating the verdict on freshness keeps the change strictly additive: `idle → healthy` for the fully-green case, nothing else changes.
- **Relax the freshness axis so a fresh heartbeat alone satisfies `Fresh` even with no `refresh_policy`.** Rejected for this change: it would let a connection with no owner-declared staleness policy go `healthy`, which over-claims. Freshness is an owner-policy axis; absent the policy, `unknown` is the honest value. Left as a possible future, owner-gated decision.
- **Synthesize a fake spine run for local collectors.** Rejected: pollutes run history with non-runs, confuses the run-detail/timeline surfaces, and conflates two genuinely different evidence sources. The verdict is a typed condition input, not a fabricated run.
- **Special-case `idle → healthy` in the dashboard.** Rejected explicitly by the task: a UI-only override hides backend uncertainty and is fragile. The verdict belongs in the durable classifier so CLI, API, and dashboard all agree (the "Owner Surfaces SHALL Share One Projection Contract" requirement).

## Acceptance checks

- A local-device connection with trusted idle outbox + complete coverage + fresh (policy-backed) freshness projects `healthy`.
- The same connection with freshness `unknown` (no refresh policy) projects `idle`, not `healthy`.
- Coverage gaps → `degraded`; stalled outbox → `degraded`; untrusted/unknown outbox → not `healthy`; no coverage diagnostics → not `healthy` (coverage stays `unknown`).
- A scheduler-managed connection with a succeeded run is unaffected; a connection with a failed run is never greened by device evidence.
- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate add-local-device-collection-verdict --strict` — passes.
