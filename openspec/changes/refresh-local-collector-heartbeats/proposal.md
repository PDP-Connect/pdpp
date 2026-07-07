## Why

Local-device collectors can run successfully after a host crash while the owner console still shows stale or repair-oriented state. The durable outbox may be draining, but the reference only has useful health if each collector pass reports current source-instance heartbeat and outbox diagnostics.

## What Changes

- Require every local collector pass to report terminal source-instance heartbeat evidence for normal, backlog-drain-only, and blocked state-read outcomes.
- Preserve local-device draining as an active work state in connection health instead of treating it as manual repair when work is still progressing.
- Add regressions for empty/backlog-only runs and stale historical scheduler state.

## Capabilities

- Modified: `local-collector-durable-work`
- Modified: `reference-connection-health`

## Impact

- Local collector package runtime behavior changes.
- Owner console local-device status becomes more self-healing after host crashes and reconnects.
