## Why

Live sources can present contradictory actionability: a failed/backed-off owner-runnable source can read as background collection with no useful action, and an active browser run can fail to appear as active in the rendered source verdict. Owners need the source surface to answer one question reliably: what can I do now, if anything?

## What Changes

- Treat failed/backed-off resumable sources as retryable owner action when the owner can start a run.
- Reserve passive wait copy for active work, source-pressure cooldown, or genuinely system-managed recovery.
- Ensure active-run evidence reaches the rendered health/verdict path.
- Keep per-stream unknown coverage as `unmeasured`, but do not let it mask a connection-level action or active run.

## Capabilities

Modified:
- reference-implementation-architecture

## Impact

- Removes misleading “Collecting — no action needed” from failed/backed-off owner-runnable sources.
- Makes active runs visible as active work in source health.
- Adds regression coverage around the live ChatGPT/Chase failure shape.
