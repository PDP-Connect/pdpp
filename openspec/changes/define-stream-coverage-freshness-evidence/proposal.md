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
- Add a settled machine audit over the cookie-gated connector summary: inspect
  every non-revoked connection, fail required unknown/unmeasured and
  required+accepted-absence regardless of pill label, treat active bounded work
  as inconclusive until it ends, and treat declared-stream count absence as a
  failure only when a current canonical record snapshot is reliable enough to
  prove an exact zero.
- Derive per-stream coverage from the latest resolved evidence across recent
  terminal fact blocks: a scoped run neither erases prior valid proof for
  omitted streams nor invents proof for them, and run selection is never
  laundered into coverage policy.
- Make canonical record counts exact: when record-snapshot evidence is current
  at its exact source checkpoint, a declared stream absent from the exhaustive
  live-record rows is an exact zero; "unavailable" is reserved for
  unobserved/stale/failed record evidence. Retained-size evidence owns byte,
  history, and blob measures only.
- Add developer-time validation so new streams cannot silently add unknown
  coverage/freshness debt, plus a reproducible machine audit that fails when a
  required stream rests unmeasured beneath a Healthy connection.
- Keep the live audit cookie-only: `PDPP_OWNER_TOKEN` is not supported against
  the cookie-gated `/_ref/connectors` summary route and is rejected before any
  HTTP request is attempted.

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
