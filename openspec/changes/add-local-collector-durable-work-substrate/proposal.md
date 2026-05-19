## Why

Local Claude Code and Codex collectors can be enrolled, but large first backfills still rely on brittle JSON queue and whole-run progress semantics. A stale `in_flight` batch, crash, rate limit, or restart can block later work and leave no trustworthy server-side checkpoint even when useful records were already accepted.

This change promotes the local collector durable-work design from research into an auditable OpenSpec lane before implementation.

## What Changes

- Define a durable local outbox for collector records, state commits, gaps, and uploads waiting for server acknowledgement.
- Define bounded local collector work units so first backfills, retries, and future sources can resume without treating a run as one monolithic batch.
- Define stale lease recovery, retry, dead-letter, and diagnostic semantics for local collector work.
- Define destination-confirmed checkpoints for local collectors: state advances only after the server durably accepts the records and gap metadata that justify it.
- Define explicit backlog/gap units for known uncollected or deferred work instead of hiding them in run failure text.
- Define local collector startup order: recover and drain durable work before scanning more source data.
- Define operator-facing health signals for queue depth, stale leases, oldest pending work, dead-letter items, backlog, last acknowledgement, and configured connection identity.
- Do not promote local collector mechanics into PDPP Core.
- Do not replace the existing Collection Profile `START`, `RECORD`, `STATE`, and `DONE` envelope contract.

## Capabilities

### New Capabilities

- `local-collector-durable-work`: Durable local collector outbox, work-unit, checkpoint, backlog, lease-recovery, and health semantics for the reference implementation.

### Modified Capabilities

- `reference-implementation-architecture`: Classify durable local collector work as reference runtime/orchestrator behavior unless a future interoperability need promotes a subset into the Collection Profile.

## Impact

- Affects `packages/local-collector`, `packages/polyfill-connectors`, and local collector CLI/service behavior.
- Affects reference server device-exporter ingest/state routes and diagnostics if new outbox acknowledgements, backlog reporting, or health fields are added.
- Affects dashboard/device exporter health UI and operator runbooks.
- Affects local Claude Code and Codex collector reliability by making large first backfills replay-safe and inspectable.
- Likely introduces a local SQLite dependency or package-level SQLite adapter for the local collector durable outbox.
- Builds on `design-local-collector-state-sync`, `introduce-local-collector-runner`, `publish-pdpp-local-collector`, and `complete-local-agent-collectors`; it does not replace those changes.
