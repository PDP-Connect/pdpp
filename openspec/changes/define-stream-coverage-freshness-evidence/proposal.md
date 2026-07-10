## Why

The reference implementation can now render typed recovery states, but many
streams still have no contract-level way to prove coverage or freshness. The
result is a durable "unknown" posture for streams that may be complete, stale,
unsupported, snapshot-only, or simply uninstrumented.

The existing `coverage_policy` manifest enum and `DETAIL_COVERAGE` message are
not enough. They cover policy and list/detail accounting, but they do not define
how every stream establishes coverage and freshness across flat streams,
snapshots, singleton streams, local-device exports, deferred streams, and
historical data that predates instrumentation.

## What Changes

- Define a stream evidence contract: every stream declares or emits how coverage
  is established from a small set of evidence strategies.
- Define a separate freshness posture contract: every stream declares or emits
  how currency is established, or explicitly says it is not freshness-trackable.
- Require the runtime/control plane to preserve per-stream evidence reports in
  the collection report consumed by source surfaces.
- Treat missing runtime evidence as a concrete unmeasured state, not as
  indefinite "checking".
- Make the connection-level coverage rollup consume the per-stream report: a
  required stream resting at unknown/unmeasured blocks a Healthy verdict and
  resolves to a maintainer/system disposition — never an owner CTA and never
  indefinite active "checking". Accepted-absence policies and proven
  local-diagnostic states stay non-degrading.
- Derive per-stream coverage from the latest resolved evidence across recent
  terminal fact blocks: a scoped run neither erases prior valid proof for
  omitted streams nor invents proof for them, and run selection is never
  laundered into coverage policy.
- Make retained-record counts exact: when the retained-size projection is fresh
  and clean, a declared stream absent from its exhaustive stream rows is an
  exact zero; "unavailable" is reserved for stale/dirty/unknown projection
  evidence.
- Add developer-time validation so new streams cannot silently add unknown
  coverage/freshness debt, plus a reproducible machine audit that fails when a
  required stream rests unmeasured beneath a Healthy connection.

## Capabilities

- Modified: `polyfill-runtime`
- Modified: `reference-connection-health`

## Impact

- Connector manifests and runtime reports gain explicit stream evidence
  semantics.
- Existing historical runs remain readable; missing old evidence projects as an
  unmeasured state instead of breaking runtime behavior.
- Owner surfaces can reserve "checking" for active bounded work and show concrete
  stream status for resting connections.
