## Why

The current source-detail handoff drops the exact run link on refresh for short or already-running syncs, and some owner-facing manual-action copy can leak connector diagnostics instead of staying instruction-shaped. The connection-level owner-action path also needs a typed exact-sync target sourced from structured attention so the exact run is not guessed from unrelated run-history state.

## What Changes

- Preserve the accepted-start run link as durable source-detail state across refresh/revalidation.
- Route connection-level owner actions to the exact run when structured attention carries a causative run id.
- Keep owner-facing assistance and push copy concise, while retaining detailed connector diagnostics outside the owner instruction string.

## Capabilities

Modified:
- reference-connection-health
- reference-run-assistance

## Impact

- Source-detail owner actions stay on the exact run instead of falling back to generic `/syncs`.
- Short syncs keep visible confirmation through a revalidation cycle.
- Manual-action and push surfaces stop exposing raw connector telemetry in owner instructions.
