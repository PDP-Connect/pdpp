# Local Collector Durable Work Substrate

Status: decided-promote
Owner: reference implementation owner
Created: 2026-05-19
Updated: 2026-05-19
Related: openspec/changes/design-local-collector-state-sync, openspec/changes/introduce-local-collector-runner, openspec/changes/publish-pdpp-local-collector, openspec/changes/add-connector-detail-gap-recovery, design-notes/full-context-refresh.md

## Question

What durable construction should make local collectors work out of the box for large first backfills, crashes, rate limits, device moves, and future data-source shapes without accumulating one-off setup features?

## Context

Local Claude Code and Codex collectors exposed a construction problem, not an enrollment problem. The collectors can be enrolled, but the current implementation still has brittle queue and progress semantics:

- Large local histories produce large JSON queue files.
- A stale `in_flight` entry can block later pending batches.
- State only commits after the queue fully drains, so a long or failed first backfill can leave no server-side connector state.
- Scan-before-drain makes recovery and device restarts slower and less predictable than necessary.
- Existing setup wrappers are useful, but they do not yet define a durable local-agent substrate.

This is the same class of problem previously seen in browser/API connectors: runs need honest partial progress, replay-safe work units, and explicit gaps/backlog instead of green-or-red whole-run outcomes.

## Stakes

The reference implementation should prove that PDPP can ingest personal data reliably from remote accounts, browser-only sources, local devices, uploaded artifacts, and future platform-native portability APIs. The local collector path should not become a special case.

The wrong solution is a long list of feature patches: reset stuck queues, add bigger JSON files, add source-specific resume flags, add more setup scripts, add ad hoc timers, and add dashboard messages for each observed failure. That would increase incidental complexity.

The right solution should identify the small set of durable primitives that make those features correct by construction.

## Research Findings

### Durable Outbox And Local Queue Prior Art

The transactional outbox pattern stores outbound work in the same durable boundary as the state change that created it, then drains it asynchronously with at-least-once delivery and idempotent consumers. The useful lesson is not microservice-specific messaging; it is the invariant that work must not be acknowledged until the destination effect is durable.

SQLite is a good substrate for a local collector outbox because it gives local ACID transactions, predictable portability, and WAL mode for concurrent readers with a single writer. SQLite alone is not enough; the schema still needs explicit states, leases, attempts, and recovery rules.

DB-backed queues such as Rails Solid Queue and Que are relevant because they use boring relational persistence for job state, claiming, retries, and durability instead of treating local memory or JSON append files as the source of truth.

Redis-backed worker systems such as Celery and Sidekiq highlight the stale-lease/visibility-timeout failure mode: if a worker claims work and dies, the work must become claimable again. This maps directly to local collector `in_flight` batches.

Kubernetes Lease objects show the value of holder identity and renewal metadata. A local collector should not use a boolean lock; it should record who claimed a work unit, until when, and under which epoch.

Design implication: replace or wrap the JSON queue with a durable outbox that has explicit states such as `ready`, `leased`, `succeeded`, and `dead_letter`; fields such as `leased_by`, `lease_epoch`, `lease_until`, `attempt_count`, `last_error`, and `next_attempt_at`; and idempotent destination acknowledgements.

### Resumable Sync, Checkpoint, And Backlog Prior Art

Airbyte, Singer, and Meltano converge on a useful principle: progress should be committed from destination-confirmed state, not source-observed state. Source observation says what was seen; durable checkpointing says what is safe to resume after.

Singer/Meltano state also highlights repeated per-stream bookmarks rather than a single global cursor. Some streams are naturally sorted and cursorable; others need signposts, partition windows, or backfill units.

Temporal's durable workflow model is useful as a design reference: long-running work should be broken into replay-safe steps with idempotent activities and explicit history. The reference implementation does not need Temporal, but it should preserve the same correctness shape locally.

Airflow and Dagster partition/backfill models are useful because they treat missed intervals or partitions as first-class work, not as invisible failure text. This matters when a collector reads "all conversations", "all local session files", "all mail attachments", or "all transactions in a date window".

Design implication: checkpoints should be per stream and, when needed, per partition/window/file/page. A checkpoint should advance only after records and known gaps for that exact boundary are durably committed. Unproven ranges should remain replayable or be represented as explicit backlog/gap units.

### Local Agent Setup And Operations Prior Art

Tailscale, Syncthing, Dropbox's Linux daemon, systemd, and launchd all separate setup phases instead of hiding everything behind one installer. The recurring shape is install, authenticate/enroll, run once, install service, inspect status, view logs, update, and troubleshoot.

Syncthing and Tailscale also demonstrate local status plus central visibility: the local agent must be inspectable from the device, while the dashboard should show fleet health, version drift, queue/backlog health, and last successful sync.

Systemd timers and launchd agents provide mature host-native scheduling, boot/login behavior, jitter, catch-up behavior, and resource controls. The reference implementation should use host-native service primitives where possible rather than inventing a scheduler daemon for local collectors.

Design implication: the local collector package should expose stable commands such as `doctor`, `enroll`, `backfill`, `service install`, `service status`, `service logs`, and `service uninstall`. First backfill should be explicit, interruptible, resumable, visible, and resource-budgeted. Steady-state collection should use OS-native service/timer mechanisms with jitter and catch-up semantics.

## Design Space

### Queue Substrate

Option: keep JSON queues.

This is simplest short-term, but it makes claiming, stale lease recovery, bounded inspection, partial acknowledgement, and crash testing harder. It also forces the implementation to read/write large files for what is logically a small state transition.

Option: use a SQLite outbox.

This is more implementation work, but it gives a durable local transaction boundary, indexed claims, bounded reads, WAL, and better inspection. This is the current leaning.

### Work Unit Shape

Option: treat a collector run as one monolithic batch.

This preserves a simple mental model but causes large first backfills to become all-or-nothing and makes retry behavior opaque.

Option: treat bounded work units as first-class.

A work unit can represent a stream partition, filesystem window, file batch, exported artifact, browser page, date range, or API page. This supports replay, backfill, metrics, and partial progress without overfitting to one source. This is the current leaning.

### Progress Semantics

Option: advance state when the collector has locally scanned data.

This is unsafe because local observation is not proof that records reached the server.

Option: advance state only after server acknowledgement for records and known gaps.

This is safer and matches destination-confirmed checkpoint prior art. This is the current leaning.

### Backlog And Gaps

Option: encode incomplete work as run failure text.

This is easy to display but hard to resume, count, prioritize, or distinguish from terminal failure.

Option: persist backlog/gap units.

Each unit should include stream, boundary, reason, retryability, first-seen run, last-attempt run, and next-attempt policy. This is the current leaning.

### Startup Order

Option: scan first, then drain the queue.

This repeats expensive work, increases local queue pressure, and delays recovery from already-prepared records.

Option: recover and drain durable outbox first, then scan for new work within budget.

This makes restarts and service resumes predictable. This is the current leaning.

### Service And Device UX

Option: rely on setup wrappers.

Setup wrappers are useful but insufficient as a long-term operator model.

Option: make the local collector an inspectable device agent.

The package should have explicit doctor/enroll/backfill/service/status/logs commands and dashboard-visible device health. This is the current leaning.

### Scheduling And Resources

Option: run as often and as fast as possible.

This risks battery, bandwidth, disk, CPU, and source-account pressure.

Option: use explicit policy budgets.

Budgets should cover queue size, upload bytes, scan files per second, memory, CPU, active hours, metered network, and first-backfill limits. This is the current leaning.

## Current Leaning

Promote a new OpenSpec change before implementing the next local collector tranche.

The durable construction should use these reference-implementation primitives:

- `connection`: owner-facing configured data source.
- `runtime`: host or surface that can execute collection work.
- `work_unit`: bounded unit of source work.
- `outbox`: durable local queue of records, gaps, state commits, and uploads waiting for acknowledgement.
- `checkpoint`: destination-confirmed progress for a stream/boundary.
- `backlog`: known uncollected or deferred work that can be retried or reported honestly.
- `policy`: schedule, resource, and attention constraints.

The first implementation should be deliberately small:

- Add a SQLite local outbox with WAL and explicit lease/retry states.
- Recover stale leases before doing new work.
- Drain acknowledged-safe pending work before scanning more source data.
- Commit state per stream/boundary only after the server durably accepts records and gap metadata.
- Represent unprocessed ranges as backlog/gap units instead of hiding them in failure text.
- Add `doctor` and `status` output that exposes queue depth, stale leases, oldest pending item, last server acknowledgement, local package version, and configured connection identity.

## Non-Goals

- Do not promote local collector mechanics into PDPP Core.
- Do not standardize source-specific backlog schemas in the Collection Profile yet.
- Do not build a custom cross-platform daemon when systemd and launchd can provide the host-native service layer.
- Do not silently auto-update local agents.
- Do not attempt cross-device deduplication or conflict resolution beyond deterministic record IDs and server-side idempotency.
- Do not use the durable outbox as a reason to make connector-specific hacks look successful.
- Do not keep a long-term JSON queue compatibility layer. A JSON queue importer is acceptable only as a temporary one-time development safety valve for the owner's current local queues and should be removed after those queues are imported or intentionally discarded.

## Promotion Trigger

Before implementing durable queue, backlog, service lifecycle, or checkpoint behavior changes, create an OpenSpec change that defines the reference-implementation storage and UX contract. The change should be explicit about what remains reference-only versus what may later become Collection Profile guidance.

## Decision Log

- 2026-05-19: Captured delegated prior-art research. Current decision: this is significant enough to promote before implementation because it changes local storage semantics, setup UX, run progress semantics, and dashboard health semantics.
- 2026-05-19: Clarified that legacy JSON queue migration is temporary. The durable design should converge on SQLite outbox only; the importer exists only to avoid silently discarding the owner's current development queues while the system is being rebuilt.

## Sources

- Transactional outbox pattern: https://microservices.io/patterns/data/transactional-outbox.html
- SQLite transactions: https://www.sqlite.org/transactional.html
- SQLite WAL: https://www.sqlite.org/wal.html
- Rails Solid Queue: https://github.com/rails/solid_queue
- Que: https://github.com/que-rb/que
- Celery Redis visibility timeout: https://docs.celeryq.dev/en/3.1/getting-started/brokers/redis.html#visibility-timeout
- Sidekiq reliability: https://github.com/sidekiq/sidekiq/wiki/Reliability
- Kubernetes Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Airbyte checkpointing: https://airbyte.com/blog/checkpointing
- Meltano state: https://sdk.meltano.com/en/v0.53.4/implementation/state.html
- Temporal workflows: https://docs.temporal.io/workflows
- Temporal activities: https://docs.temporal.io/activities
- Airflow DAG runs and catchup: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html
- Dagster backfills: https://docs.dagster.io/guides/build/partitions-and-backfills/backfilling-data
- Tailscale CLI: https://tailscale.com/docs/reference/tailscale-cli
- Tailscale client updates: https://tailscale.com/docs/features/client/update
- Syncthing autostart: https://docs.syncthing.net/users/autostart
- Syncthing service options: https://docs.syncthing.net/v2.0.0/users/syncthing.html
- Syncthing REST API: https://docs.syncthing.net/dev/rest.html
- Dropbox Linux commands: https://help.dropbox.com/installs/linux-commands
- systemd timers: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- systemd resource control: https://www.freedesktop.org/software/systemd/man/254/systemd.resource-control.html
- launchd reference: https://www.launchd.info/
