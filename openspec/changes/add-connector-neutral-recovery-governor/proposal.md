## Why

Recoverable connector detail work is currently governed partly by connector-local
caps and partly by scheduler cooldowns. That prevents one runaway run, but it
does not provide a connector-neutral way to continue recovery safely across runs
or to explain the state to the owner without vague "Checking" copy.

## What Changes

- Add a connector-neutral recovery governor for durable detail-gap work. It
  admits recovery attempts as provider work items across runs, using the existing
  provider-budget, send-governor, detail-gap, and cooldown substrates instead of
  asking an owner to repeatedly click retry.
- Treat fixed per-run detail caps as blast-radius limits only. They defer
  remaining work to the recovery governor; they do not define the steady-state
  recovery workflow.
- Require recovery attempts, retries, and manual owner-started reruns to respect
  the same provider work-domain cooldown and pacing rules unless an explicit
  force path is used.
- Require recovery outcomes to distinguish planned run caps, provider pressure,
  transient detail failures, connector defects, and owner-required repair.
- Replace indefinite owner-facing "Checking" with typed, time-bounded states:
  active check, queued recovery, cooling down, waiting for owner, system issue,
  unknown evidence, or refresh available.
- Guarantee liveness: eligible queued recovery is self-scheduled on cadence; a
  source-pressure cooldown gates pressure-class retries but never starves
  non-pressure recovery (the live 51-holds-942 ChatGPT starvation class); a
  stall watchdog turns silent queue rot into a visible system condition.
- Make recovery replay-safe: idempotent record emission on re-attempt,
  crash-honest attempt accounting, and per-item quarantine so a poison item
  cannot consume the backlog's budget or hide as endless retries.
- Record every admission decision (grant, deny with reason, forced) for
  owner-only diagnostics; force paths are audited and never unlock unattended
  interactive auth repair.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `polyfill-runtime`: defines connector-neutral recovery admission for durable
  detail-gap work and its relationship to provider pacing, run caps, retry
  budgets, and source-pressure cooldowns. Also defines the connector-runtime
  source boundary's typed `browser_surface_attach_exhausted` code contract:
  the single place that classifies the narrow CDP attach-session race and
  carries a stable code through `DONE.error.code`, surviving connector
  `normalizeTerminalError` overrides.
- `reference-connection-health`: defines owner-facing projection requirements
  for recovery state and for eliminating indefinite "Checking" as an
  actionability bucket.
- `reference-implementation-runtime`: defines the controller's managed-surface
  lifecycle response to a typed `connector_error.code ===
  "browser_surface_attach_exhausted"` on a pre-progress dynamic-surface
  failure — recycle the surface within the existing retry budget, never by
  re-parsing message text, and never touching a static/operator-owned
  surface.

## Impact

- Affects connector runtime context, detail-gap recovery loops, scheduler/manual
  run admission, connection-health projection, and owner-console actionability.
- Does not change PDPP Core, grant semantics, grant-scoped `/v1` reads, or the
  portable Collection Profile wire format. The detail-gap recovery substrate
  remains reference-owned.
- Amazon order-item recovery is the immediate proving case, but the contract is
  connector-neutral and applies to any first-party connector that emits durable
  recoverable detail gaps.
