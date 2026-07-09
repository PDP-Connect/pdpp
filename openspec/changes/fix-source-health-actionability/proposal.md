## Why

Live sources can present contradictory actionability: a failed/backed-off owner-runnable source can read as background collection with no useful action, and an active browser run can fail to appear as active in the rendered source verdict. Owners need the source surface to answer one question reliably: what can I do now, if anything?

## What Changes

- Treat failed/backed-off resumable sources as retryable owner action when the owner can start a run.
- Reserve passive wait copy for active work, source-pressure cooldown, or genuinely system-managed recovery.
- Ensure active-run evidence reaches the rendered health/verdict path.
- Keep per-stream unknown coverage as `unmeasured`, but do not let it mask a connection-level action or active run.
- Stop rendering a green `Healthy` pill for connections that are idle-with-prior-success, stale, paused, or `owner_refresh_due` — these now render `amber`/`advisory` with a new `Needs refresh` label, distinct from `Degraded` (real coverage/attention/outbox trouble or a broken state/disposition), while a genuinely never-run connection stays green/grey.

## Capabilities

Modified:
- reference-implementation-architecture

## Impact

- Removes misleading “Collecting — no action needed” from failed/backed-off owner-runnable sources.
- Makes active runs visible as active work in source health.
- Adds regression coverage around the live ChatGPT/Chase failure shape.
- Removes a false-positive green pill on idle/stale/paused/manual-refresh-due connections (e.g. Vana Slack, Amazon - Personal), replacing the prior deliberate `green/advisory` design with `amber/advisory` + a new `Needs refresh` label distinguished from genuinely never-run idle connections via `last_success_at`, and from real degradation (`Degraded`, e.g. Chase/USAA retryable-gap/attention-open cases) via the coverage/attention/outbox axes and broken state/disposition values.
