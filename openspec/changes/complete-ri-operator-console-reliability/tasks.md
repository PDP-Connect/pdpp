## 1. Design Synthesis And Owner Gate

- [x] 1.1 Complete four bounded research reports for operator state prior art, durable work/resource isolation, attention/notification UX, and PDPP boundary/acceptance model.
- [x] 1.2 Reconcile research findings into `design.md`, including accepted changes and rejected counterarguments.
- [x] 1.3 Finalize the canonical connection health projection precedence and evidence inputs.
- [x] 1.4 Finalize milestone scope boundaries: what is required for this reliability milestone versus connector-specific green-state follow-up.
- [x] 1.5 Run `openspec validate complete-ri-operator-console-reliability --strict`.

## 2. Evidence Inventory

- [x] 2.1 Inventory current durable evidence sources for runs, schedules, active runs, detail gaps, local collector outbox, device exporters, remote-surface leases, projection freshness, and connector coverage.
- [x] 2.2 Identify missing durable evidence required by the connection health projection.
- [x] 2.3 Add or normalize reference-only evidence shapes needed for connection-scoped health without changing PDPP Core surfaces.
- [x] 2.4 Add secret-redaction checks for any evidence exposed through dashboard, CLI/status, timelines, or notifications.

## 3. Connection Health Projection

- [x] 3.1 Implement a connection health projection module with deterministic precedence for healthy, degraded, needs-attention, cooling-off, blocked, idle, and unknown.
- [x] 3.2 Project orthogonal connection axes for freshness, coverage, attention, and outbox/work health; render syncing/activity as a badge rather than a health state.
- [ ] 3.3 Project coverage by connection and stream/scope boundary, including complete, partial, deferred, unsupported, unavailable, retryable gap, terminal gap, inventory-only, and unknown.
- [x] 3.4 Integrate scheduler/backoff evidence so cooling-off and next-attempt semantics survive restart.
- [ ] 3.5 Integrate detail-gap/backlog evidence so success-with-gaps never projects as healthy.
- [x] 3.6 Add projection-unreliable handling so failed/missing/stale required evidence projects to unknown.
- [x] 3.7 Add tests for every canonical health state, every axis, and state precedence conflict.

## 4. Executor Bounds And Durability

- [ ] 4.1 Finish local collector runner integration with the durable outbox: recover expired leases, drain ready work before scanning, and use destination-confirmed checkpoints.
- [ ] 4.2 Replace local collector full-output buffering with streaming or bounded batch ingestion for Claude/Codex-scale first backfills.
- [ ] 4.3 Add local collector resource/backlog policy for duration, batch size, queue depth, retry, and dead-letter behavior.
- [ ] 4.4 Add restart/crash tests for local collector enqueue-before-ack, upload-before-local-ack, state-staged-before-commit, and stale lease recovery.
- [ ] 4.5 Audit browser/API connector executor paths for unbounded memory/concurrency/backoff risks and fix any milestone-blocking path.
- [ ] 4.6 Audit dashboard projection rebuild/reconcile paths for resource bounds, cancellation, stale/failure visibility, and non-destructive rollback.

## 5. Structured Attention And Notifications

- [x] 5.1 Normalize run and connection attention evidence with attention id, dedupe key, reason, action target, expiry, auto-detection, lifecycle state, privacy classification, and recovery semantics.
- [x] 5.2 Add lifecycle support for open, acknowledged, in-progress, resolved, expired, cancelled, and superseded attention.
- [ ] 5.3 Integrate attention evidence into connection health projection and dashboard CTAs.
- [ ] 5.4 Update PWA/Web Push policy so it delivers actionable attention and important health transitions without owning state.
- [x] 5.5 Add dedupe/cooldown behavior for repeated prompts and repeated non-actionable failures.
- [ ] 5.6 Add tests for OTP/push approval, re-consent/manual browser verification, missing local device, timeout, cancellation, supersession, and auto-detected completion.

## 6. Dashboard And CLI Operator Surfaces

- [ ] 6.1 Update dashboard connection rows/cards to render projected state, coverage, last durable progress, pending work, next action, and projection freshness.
- [ ] 6.2 Ensure local collector/device-exporter diagnostics are scoped to connection/source instance rather than connector type only.
- [ ] 6.3 Add dashboard detail views or expandable diagnostics for evidence, coverage, backlog, schedules, remote surfaces, and runtime/device state.
- [ ] 6.4 Update CLI/status surfaces to inspect the same reference evidence used by the dashboard.
- [ ] 6.5 Ensure loading/stale/error states never render false zeroes or false green.

## 7. Milestone Acceptance

- [ ] 7.1 Add acceptance tests for healthy, degraded, needs-attention, cooling-off, blocked, idle, and unknown connection health states.
- [ ] 7.2 Add acceptance tests proving syncing/activity, stale freshness, gaps, and outbox backlog render as axes or badges rather than headline health states.
- [ ] 7.3 Add acceptance tests proving success-with-gaps and unsupported required streams do not project as healthy.
- [ ] 7.4 Add restart acceptance proving active/pending/retrying/blocked state is reconstructed from durable evidence.
- [ ] 7.5 Add load/resource acceptance proving large local backfills and summary rebuilds do not require unbounded memory or destabilize the host.
- [ ] 7.6 Add a browser/API connector acceptance path proving structured attention and remote-surface status feed the connection projection.
- [ ] 7.7 Run relevant reference implementation, web, local collector, and polyfill connector checks.
- [ ] 7.8 Run `openspec validate complete-ri-operator-console-reliability --strict`.
- [ ] 7.9 Run `openspec validate --all --strict` or document unrelated pre-existing failures.

## 8. Closeout Hygiene

- [ ] 8.1 Remove temporary legacy local queue import/quarantine support after current local queues are imported or intentionally discarded.
- [ ] 8.2 Mark superseded design notes and partial changes that this milestone absorbs or depends on.
- [ ] 8.3 Commit and push verified tranches in small reviewable groups.
- [ ] 8.4 Record final milestone evidence and remaining connector-specific follow-ups.
