# RI Operator Console Reliability Research Synthesis

Status: decided-promoted
Owner: reference implementation owner
Created: 2026-05-19
Updated: 2026-05-20
Related: `openspec/changes/complete-ri-operator-console-reliability`, `design-notes/full-context-refresh.md`, `design-notes/local-collector-durable-work-substrate-2026-05-19.md`, `docs/connector-health-state-research-2026-05-15.md`

## Question

What prior-art and local-evidence findings raise the broader RI/operator-console reliability design from plausible to 95%+-confidence SLVP-ideal?

## Research Method

Four read-only workers investigated bounded questions:

- Operator state prior art and connection health taxonomy.
- Durable work and resource isolation.
- Human attention, notification, and interaction UX.
- PDPP boundary audit and milestone acceptance.

The full local reports were written under `tmp/workstreams/ri-opconsole-worker-*-report.md`. This note preserves the owner-level findings that were promoted into the OpenSpec change.

## Findings

### Connection Health

The operator console should preserve the existing six-state health taxonomy and add only one new headline state:

- `healthy`
- `degraded`
- `needs_attention`
- `cooling_off`
- `blocked`
- `idle`
- `unknown`

`syncing`, `stale`, `gaps`, and outbox depth should not become headline states. They are orthogonal axes or badges:

- freshness: `fresh`, `stale`, `unknown`
- coverage: `complete`, `partial`, `inventory_only`, `none`
- attention: `none`, `pending`, `overdue`, `expiring_soon`
- outbox/work health: `clean`, `backlogged`, `stuck`, `unknown`, `n/a`

The strongest reason to add `unknown` is avoiding silent green when the projection itself is unreliable. Prior art includes Datadog `No Data`, Sentry unknown session/release health, Temporal's separation between workflow state and task-queue health, and Dagster freshness as an axis rather than an execution state.

Accepted projection precedence:

1. projection unreliable -> `unknown`
2. manual paused or never ran -> `idle`
3. assistance open -> `needs_attention`
4. blocked promotion -> `blocked`
5. backoff applied -> `cooling_off`
6. outbox/work stuck -> `degraded`
7. run outcome -> `healthy` or `degraded`
8. fallback -> `unknown`

### Durable Work And Resource Isolation

The universal executor contract should require durability, idempotent work ids, leases/fencing, bounded reads, bounded child stdout/stderr, cancellation, host resource limits, drain-before-scan startup, destination-confirmed checkpoints, restart reconstruction, and secret-safe diagnostics.

Local collector-specific gaps found in the current repo:

- The temporary legacy queue import/quarantine bridge has been removed after no local queue files were found to import.
- The current collector runner still scans/spawns before durable drain.
- Child connector output is still buffered in memory before upload.
- Child stderr is unbounded in some runner paths.
- Cancellation is not propagated consistently with `AbortSignal`.
- Lease renewal during long uploads is not yet integrated.
- Host-native systemd/launchd unit templates with resource limits are not yet present.

Prior art supporting this contract includes transactional outbox, SQLite WAL, Celery/Sidekiq visibility timeouts, Solid Queue/Que database-backed queues, Kubernetes Leases, Temporal activity heartbeats, Airbyte/Singer/Meltano destination-confirmed state, Airflow/Dagster partitions/backfills, systemd resource controls, and adaptive concurrency/backpressure libraries.

### Attention And Notifications

The attention model should use orthogonal axes, not connector-specific enum growth. Required fields include `attention_id`, `dedupe_key`, connection/run identity, reason code, display-safe copy, action target, lifecycle, expiry, auto-detection mode, sensitivity, and notification policy.

Accepted lifecycle:

- `open`
- `acknowledged`
- `in_progress`
- `resolved`
- `expired`
- `cancelled`
- `superseded`

Accepted axes:

- progress posture: `running`, `blocked`, `waiting_retry`
- owner action: `none`, `act_elsewhere`, `provide_value`, `operate_attachment`
- response contract: `none`, `response_required`
- sensitivity: `none`, `non_secret`, `secret`
- auto-detect: `polling`, `webhook`, `callback`, `none`

PWA/Web Push is an attention delivery channel, not state authority. Push payloads should contain lock-screen-safe display copy and `attention_id`, not secrets, stream tokens, cookies, OTPs, fixture pointers, or raw connector output. Repeated attention should use dedupe and cooldown rather than repeated prompts.

Prior art includes Plaid item lifecycle and Link update mode, OAuth device flow, Stripe Connect requirements and webhook disablement, GitHub Checks `action_required`, Tailscale device/key expiry, Syncthing pending folders/devices, Web Push/PWA constraints, PagerDuty dedupe/escalation, and Apple notification guidance.

### Boundary And Acceptance

The milestone belongs to reference runtime/operator and dashboard projection layers. It should not change PDPP Core grants/query semantics or Collection Profile messages.

Accepted milestone definition:

The RI/operator-console reliability milestone makes the reference implementation's operator console the single trustworthy surface for real collection across every configured connection. Every long-running execution path must be durable, bounded, crash-recoverable, secret-safe, and owner-actionable. Connection health is a deterministic projection over durable run, coverage, work, attention, schedule, runtime, and read-model evidence, not over last-run exit codes. Closing the milestone means the console tells the truth under success, partial success, retry/backoff, crash/restart, local backlog, pending human action, stale projections, and host-load pressure without requiring every connector to be green.

## Closeout Relationship Map

Absorbed by `complete-ri-operator-console-reliability`:

- Connection health taxonomy and precedence from this research note.
- Durable scheduler/backoff, active-run, detail-gap, attention, local-outbox, projection-freshness, and resource-bound evidence integration tranches.
- The temporary legacy local queue import/quarantine bridge was removed after no local queue files were found to import.

Still independently active and not absorbed:

- `add-local-collector-durable-work-substrate`: remaining durable executor details such as scan/drain ordering, bounded child buffering, cancellation propagation, lease renewal, and host-native unit templates.
- `publish-pdpp-local-collector`: packaging/publish-readiness for the local collector package.
- `complete-local-agent-collectors`: connector-specific local collector completeness.
- Remote-surface OSS/package changes: package extraction and allocator boundaries are separate; this milestone only consumes status evidence for operator health when wired.

Dependency only:

- `define-connector-instances`, scheduler changes, connector detail-gap recovery, and source/device exporter work provide durable evidence this milestone projects, but their broader specs remain their own artifacts.

Accepted invariants:

- no false success
- no silent loss
- bounded execution
- restart reconstruction
- honest coverage
- owner-actionable states
- projection freshness
- secret-safe diagnostics

## Strongest Counterargument

The milestone could become a broad abstract checklist that delays concrete connector repairs.

Owner response: the prior pattern of connector-specific heroics did not compound. The accepted design is intentionally a small set of primitives and invariants: connection, evidence, coverage, bounded work, policy, attention, runtime capacity, and derived projection. Connector-green work should become faster and safer after this substrate, not blocked by endless abstraction.

## Decision

Promote these findings into `openspec/changes/complete-ri-operator-console-reliability/design.md`, `tasks.md`, and the reference-implementation-architecture spec delta. Use the milestone tasks as the integration plan before dispatching implementation workers.
