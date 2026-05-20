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
- [ ] 3.3 Project coverage by connection and stream/scope boundary, including complete, partial, deferred, unsupported, unavailable, retryable gap, terminal gap, inventory-only, and unknown. (Partially honest: durable evidence supports `complete`, `partial`, `retryable_gap`, `terminal_gap`, and `unknown`. `deferred`, `unsupported`, `unavailable`, and `inventory_only` require manifest-declared required-stream policy and accepted-coverage tracking the milestone has not landed yet; documented as residual risk.)
- [x] 3.4 Integrate scheduler/backoff evidence so cooling-off and next-attempt semantics survive restart.
- [x] 3.5 Integrate detail-gap/backlog evidence so success-with-gaps never projects as healthy.
- [x] 3.6 Add projection-unreliable handling so failed/missing/stale required evidence projects to unknown.
- [x] 3.7 Add tests for every canonical health state, every axis, and state precedence conflict.

## 4. Executor Bounds And Durability

- [x] 4.1 Finish local collector runner integration with the durable outbox: recover expired leases, drain ready work before scanning, and use destination-confirmed checkpoints.
- [x] 4.2 Replace local collector full-output buffering with streaming or bounded batch ingestion for Claude/Codex-scale first backfills.
- [x] 4.3 Add local collector resource/backlog policy for duration, batch size, queue depth, retry, and dead-letter behavior.
- [x] 4.4 Add restart/crash tests for local collector enqueue-before-ack, upload-before-local-ack, state-staged-before-commit, and stale lease recovery.
- [x] 4.5 Audit browser/API connector executor paths for unbounded memory/concurrency/backoff risks and fix any milestone-blocking path.
- [x] 4.6 Audit dashboard projection rebuild/reconcile paths for resource bounds, cancellation, stale/failure visibility, and non-destructive rollback.

## 5. Structured Attention And Notifications

- [x] 5.1 Normalize run and connection attention evidence with attention id, dedupe key, reason, action target, expiry, auto-detection, lifecycle state, privacy classification, and recovery semantics.
- [x] 5.2 Add lifecycle support for open, acknowledged, in-progress, resolved, expired, cancelled, and superseded attention.
- [x] 5.3 Integrate attention evidence into connection health projection and dashboard CTAs. (Projection boundary landed: `projectConnectorSummaryConnectionHealth` accepts structured `AttentionRecord[]`, uses `attention.isHealthRelevant` for filtering, and emits a non-secret `next_action` CTA carrying `attention_id`, `reason_code`, `owner_action`, `action_target`, `expires_at`, and a `source` field that degrades to `schedule_fallback` when only the schedule's `human_attention_needed` flag is available. Secret-sensitive records suppress `action_target`. Durable store/read and dashboard CTA landed: `connector_attention_records` persists scoped rows, `ref-control` reads them into list/detail projections and degrades to `unknown` on store read failure, and dashboard rows render structured CTAs or caveated `schedule_fallback` text without linking raw action targets. Production writers landed: `runtime/attention-writer.js` upserts a structured row on every INTERACTION and ASSISTANCE owner-action prompt the runtime relays from a connector subprocess, transitions the row to `resolved`/`expired`/`cancelled` on INTERACTION_RESPONSE / ASSISTANCE_STATUS / run termination, scopes rows by (connector_id, connector_instance_id), uses non-secret action targets only (`dashboard`, `remote_surface`, `external_app`), persists secret prompts with `sensitivity: "secret"` so the projection suppresses their `action_target`, and degrades to a logged warning on store outage rather than crashing the run. Validated end-to-end in `reference-implementation/test/attention-writer.test.js`: a stub connector emitting INTERACTION now drives `next_action.source === "structured"` while open and stops driving `needs_attention` after DONE succeeded.)
- [x] 5.4 Update PWA/Web Push policy so it delivers actionable attention and important health transitions without owning state.
- [x] 5.5 Add dedupe/cooldown behavior for repeated prompts and repeated non-actionable failures.
- [x] 5.6 Add tests for OTP/push approval, re-consent/manual browser verification, missing local device, timeout, cancellation, supersession, and auto-detected completion.

## 6. Dashboard And CLI Operator Surfaces

- [x] 6.1 Update dashboard connection rows/cards to render projected state, coverage, last durable progress, pending work, next action, and projection freshness.
- [x] 6.2 Ensure local collector/device-exporter diagnostics are scoped to connection/source instance rather than connector type only. (Per-source identity now surfaces through `/_ref/device-exporters/diagnostics`: each `device_source_instance` row carries `source_instance_id`, `device_id`, `connector_instance_id`, `connector_id`, `local_binding_name`, `display_name`, per-source `last_heartbeat_at`/`last_heartbeat_status`/`records_pending`, per-source `accepted_record_count`/`rejected_record_count`/`last_ingest_at`, and a `local_collector_gaps` block scoped to that source instance with `pending_count`, `reasons`, `last_updated_at`, and `unreliable` so a gap-store read failure cannot render a silent false zero. The connector summary projection now reads pending detail gaps with `listPendingGapsForConnector(connectorId)` so per-device gaps no longer collapse into the legacy default connector instance and silently drop from the dashboard. Regression test `device-exporter diagnostics scope heartbeat, ingest, and local-collector gaps to the source instance` proves two devices on the same connector type keep their heartbeat, ingest, and gap diagnostics isolated.)
- [x] 6.3 Add dashboard detail views or expandable diagnostics for evidence, coverage, backlog, schedules, remote surfaces, and runtime/device state.
- [x] 6.4 Update CLI/status surfaces to inspect the same reference evidence used by the dashboard.
- [x] 6.5 Ensure loading/stale/error states never render false zeroes or false green.

## 7. Milestone Acceptance

- [x] 7.1 Add acceptance tests for healthy, degraded, needs-attention, cooling-off, blocked, idle, and unknown connection health states.
- [x] 7.2 Add acceptance tests proving syncing/activity, stale freshness, gaps, and outbox backlog render as axes or badges rather than headline health states.
- [ ] 7.3 Add acceptance tests proving success-with-gaps and unsupported required streams do not project as healthy. (Partially covered: success-with-gaps is pinned; unsupported required streams still depend on the 3.3 manifest/accepted-coverage residual.)
- [x] 7.4 Add restart acceptance proving active/pending/retrying/blocked state is reconstructed from durable evidence.
- [x] 7.5 Add load/resource acceptance proving large local backfills and summary rebuilds do not require unbounded memory or destabilize the host.
- [ ] 7.6 Add a browser/API connector acceptance path proving structured attention and remote-surface status feed the connection projection. (Partially covered: structured attention is pinned; remote-surface status has no production path into `ref-control` connection health yet.)
- [ ] 7.7 Run relevant reference implementation, web, local collector, and polyfill connector checks.
- [ ] 7.8 Run `openspec validate complete-ri-operator-console-reliability --strict`.
- [ ] 7.9 Run `openspec validate --all --strict` or document unrelated pre-existing failures.

## 8. Closeout Hygiene

- [ ] 8.1 Remove temporary legacy local queue import/quarantine support after current local queues are imported or intentionally discarded.
- [ ] 8.2 Mark superseded design notes and partial changes that this milestone absorbs or depends on.
- [ ] 8.3 Commit and push verified tranches in small reviewable groups.
- [ ] 8.4 Record final milestone evidence and remaining connector-specific follow-ups.
