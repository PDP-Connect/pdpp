## Context

The local collector path has already gained enrollment, packaging, source-instance state sync, and source-home inventory work through related OpenSpec changes. Those changes made local collection possible, but they did not fully solve durable work execution.

Current pressure points:

- Local Claude Code and Codex homes can produce large first backfills.
- Prepared records are held in large JSON queue files.
- A stale `in_flight` item can block pending work behind it.
- State commits are tied to whole-pass drain behavior, so useful accepted records can still leave no trustworthy server-side checkpoint.
- Re-running after a crash or failed upload can repeat expensive source scans before draining already-prepared work.
- Dashboard/operator visibility is too coarse to distinguish "collector is enrolled" from "collector has a durable backlog, stale lease, dead-letter item, or uncommitted checkpoint."

Prior-art research is captured in `design-notes/local-collector-durable-work-substrate-2026-05-19.md`. The key imported ideas are transactional outbox, destination-confirmed checkpoints, bounded work units/partitions, stale lease recovery, and inspectable local agent operations.

This design is reference-implementation architecture. It does not change PDPP Core grants, resource-server disclosure semantics, or the Collection Profile message envelope.

## Goals / Non-Goals

**Goals:**

- Make large local first backfills restartable and replay-safe.
- Replace brittle JSON queue semantics with a durable local outbox model.
- Ensure local state/checkpoint advancement is destination-confirmed.
- Preserve known uncollected work as explicit backlog/gap units.
- Recover stale local leases without manual queue surgery.
- Provide local and dashboard-visible diagnostics that explain queue/backlog health.
- Keep the design general enough for local files, local app stores, uploaded artifacts, browser/export work, and future source-specific collectors.

**Non-Goals:**

- Do not promote local collector storage mechanics into PDPP Core.
- Do not redefine Collection Profile `START`, `RECORD`, `STATE`, or `DONE`.
- Do not solve every local Claude/Codex stream in this change.
- Do not build a custom cross-platform daemon when systemd/launchd can provide service scheduling.
- Do not add silent auto-update, cross-device conflict resolution, or source-specific backlog schemas.
- Do not use durable backlog as a way to hide connector-specific failures behind success.

## Decisions

### Use A SQLite Durable Outbox For Local Collector Work

The local collector SHALL store prepared outbound work in a local durable outbox. SQLite with WAL is the default substrate unless implementation evidence shows a stronger local embedded store is needed.

The outbox stores at least these work kinds:

- record batches waiting for server ingest acknowledgement
- state/checkpoint commits waiting for server acknowledgement
- gap/backlog reports waiting for server acknowledgement
- artifact/blob upload work when a local stream emits blobs

Each row has explicit lifecycle fields such as status, attempt count, next-attempt time, lease holder, lease epoch, lease deadline, last error, created time, and updated time.

Alternative considered: keep JSON queue files and patch stale `in_flight` handling. Rejected because it keeps large-file rewrite behavior, makes indexed inspection awkward, and treats local work claims as incidental state instead of a durable boundary.

### Treat Bounded Work Units As The Unit Of Progress

The collector runner SHALL break local source work into bounded units. A unit can represent a stream partition, source-home scan window, file batch, page/export result, date range, or other source-specific boundary.

Work units are reference runtime constructs, not Collection Profile messages. A connector child can continue emitting normal `RECORD`, `STATE`, and `DONE` messages; the local runner maps those outputs into durable outbox rows and checkpoint/backlog decisions.

Alternative considered: keep one monolithic "run" as the only progress unit. Rejected because it makes large first backfills all-or-nothing and gives no durable place to resume or report a precise gap.

### Recover And Drain Before Scanning More Source Data

On startup or scheduled execution, the local runner SHALL:

1. Open the durable outbox.
2. Recover expired leases for its connection/source instance.
3. Drain ready retryable outbox rows within policy limits.
4. Only then scan source data for new work.

This order prevents repeated scanning from masking a stuck upload backlog and makes restarts deterministic.

Alternative considered: scan first, enqueue more, then drain. Rejected because it increases queue pressure and delays recovery of already-prepared work.

### Advance Checkpoints Only After Destination Acknowledgement

Local collector checkpoints SHALL be destination-confirmed. A source-observed cursor, local file offset, scan marker, or connector-emitted `STATE` is not a committed checkpoint until the records and known gap metadata for that boundary are durably accepted by the server.

The local runner may stage attempted progress locally, but dashboard and server state must distinguish staged progress from committed checkpoint.

Alternative considered: write state as soon as the connector emits `STATE`. Rejected because it can skip records after a crash or network failure.

### Make Backlog And Gaps First-Class

Known incomplete work SHALL be represented as durable backlog/gap units with machine-readable reason and retryability rather than only as run failure prose.

Examples:

- a file batch could not be read
- an attachment upload exceeded a policy budget
- a source partition was deferred because first-backfill budget expired
- a stream is inventory-only until privacy review approves payload collection
- a retryable server pressure error deferred a work unit

The backlog is not a success mask. It is how the reference reports partial progress honestly and gives future runs targetable work.

Alternative considered: report gaps only in `DONE` or timeline text. Rejected because text-only gaps cannot drive retries, dashboards, or operator decisions reliably.

### Use Leases With Holder Identity And Epochs

Outbox claiming SHALL use leases with holder identity, epoch, and expiration. Expired leases become recoverable. A worker that resumes after losing its lease must not be able to acknowledge stale work without passing a fencing check.

Alternative considered: simple boolean `in_flight`. Rejected because it created the current stuck-queue class of failure.

### Keep Service Lifecycle Host-Native But Inspectable

The package should expose stable commands such as `doctor`, `enroll`, `backfill`, `service install`, `service status`, `service logs`, and `service uninstall`. Host-native service layers such as systemd timers and launchd agents should own periodic execution, jitter, boot/login behavior, and resource controls where possible.

The local collector itself owns durable work and health reporting; it should not become a general-purpose scheduler daemon.

Alternative considered: create a custom daemon with its own scheduling semantics. Rejected for now because it adds incidental complexity and duplicates host primitives.

### Report Health At The Connection/Source-Instance Boundary

Diagnostics SHALL be scoped to the configured connection/source instance rather than only connector type. Health should include:

- pending, leased, retrying, succeeded, and dead-letter work counts
- oldest pending work age
- stale lease count
- backlog/gap count by stream/reason/retryability
- last server acknowledgement time
- last committed checkpoint per stream/boundary
- package/protocol version
- configured device and source-home identity

This composes with the connection namespace work: multiple Gmail accounts, multiple Claude homes, and multiple devices need separate health.

## Risks / Trade-offs

- **Risk:** SQLite adds implementation and packaging complexity.  
  **Mitigation:** Keep the schema small, isolate it inside the local collector package, and prove it with crash/restart tests before widening use.

- **Risk:** Bounded work units can become over-generalized.  
  **Mitigation:** Start with the minimum work-unit fields needed for local Claude/Codex first backfills and preserve source-specific details as opaque metadata unless they become shared semantics.

- **Risk:** Backlog/gap units can make incomplete runs look acceptable.  
  **Mitigation:** Dashboard and run status must distinguish clean completion, completion with gaps, retryable backlog, and terminal dead-letter work.

- **Risk:** Lease recovery can duplicate uploads.  
  **Mitigation:** Require deterministic batch/work ids and server idempotency. At-least-once local delivery is acceptable only when destination effects are idempotent.

- **Risk:** Migration from JSON queues can lose pending local work.  
  **Mitigation:** Add an importer or quarantine path that preserves old JSON queue contents before enabling the SQLite path by default.

- **Risk:** The design may accidentally leak reference-only concepts into PDPP Core.  
  **Mitigation:** Keep spec wording scoped to reference implementation behavior and add an architecture requirement classifying durable local work as runtime/orchestrator behavior.

## Migration Plan

1. Add the local durable outbox schema and adapter behind a package-local interface.
2. Add read-only `doctor/status` inspection for both old JSON queues and the new outbox where possible.
3. Add migration or quarantine handling for existing JSON queues.
4. Switch local collector enqueue/drain to the durable outbox for one low-risk connector path.
5. Add crash/restart tests around enqueue, lease, upload acknowledgement, state commit, backlog creation, and stale lease recovery.
6. Enable the durable outbox for Claude Code and Codex local collectors.
7. Update dashboard/operator diagnostics to display connection-scoped outbox/backlog health.

Rollback should disable the new outbox path for new runs while preserving the SQLite file for inspection. If migration has already imported JSON queue rows, rollback must not delete either queue representation automatically.

## Open Questions

- Should backlog/gap units be stored only locally until uploaded, or also become a server-side diagnostic table for all connector types?
- What is the smallest server acknowledgement shape needed for state commits and backlog reports without overfitting to local collectors?
- Should a local work unit have a public operator-visible identifier, or remain an internal diagnostic id unless debugging is enabled?
- Which parts of this reference runtime model, if any, should eventually become Collection Profile guidance for long-running or device-pushed collectors?
