## Context

The reference implementation has accumulated several strong but partial operator capabilities: scheduler persistence, scheduler backoff, dashboard summary read models, connector detail gaps, local collector packaging, local outbox primitives, remote browser surfaces, PWA notification work, and connector health research. The weakness is synthesis. The operator console can still feel unreliable because state is fragmented across last-run status, schedule rows, local queues, run timelines, surface leases, connector-specific gaps, projection freshness, and human-action prompts.

The user-visible problem is not "some dashboard page is slow" or "one connector is red." The problem is that an owner running real connectors needs to know, for every configured source: what is happening, whether useful data was durably collected, what is missing, what action is required, whether the system will retry, and whether the personal server is safe from runaway work.

This change treats the broader RI/operator-console milestone as a reliability construction milestone, not as a connector-green checklist.

## Goals / Non-Goals

**Goals:**

- Define one owner-facing connection health model backed by durable evidence.
- Make green/yellow/red semantics explicit and hard to misuse.
- Ensure long-running work is bounded, durable, restart-reconstructable, and resource-safe.
- Make coverage, gaps, backlog, stale data, retry/cooldown, blocked work, and human attention first-class.
- Keep runtime/device/surface details separate from owner-facing source identity.
- Define the acceptance suite required before claiming the RI/operator console is reliable.
- Preserve PDPP Core and Collection Profile boundaries.

**Non-Goals:**

- Do not require every connector to be fully green before this milestone closes.
- Do not standardize reference-only scheduler, outbox, n.eko, PWA, or dashboard projection mechanics as PDPP Core.
- Do not hide connector-specific failures behind a more polished global state model.
- Do not build a generalized workflow engine, alerting platform, or projection framework.
- Do not keep temporary legacy queue compatibility as a long-term supported feature.

## Decisions

### Decision: A Connection Is The Owner-Facing Unit

The operator console should center on `connection`: a configured owner source such as "Gmail personal", "ChatGPT account", "Chase card", "Claude Code on Simon laptop", or "Codex on root server".

`connector_id` is implementation type. `device` or `runtime` is execution capacity. `run` is evidence. `schedule` is policy. `surface` is interaction capability. `grant` governs disclosure. None of these should replace `connection` as the primary owner-facing row.

Alternative considered: keep connector type as the primary row. Rejected because it fails multi-account Gmail/Amazon/Claude cases and conflates implementation with configured source.

Strongest counterargument: this noun model adds implementation work before every connector is green.

Owner answer: the extra noun is justified because without it connector-green work cannot remain correct for multi-account, multi-device, local collector, browser surface, and schedule cases.

### Decision: Run Is Evidence, Not State

A run produces durable evidence: started, progressed, emitted records, staged/committed checkpoints, reported gaps, requested attention, retried, failed, succeeded, or was cancelled. A connection's current state is projected from this evidence plus durable work and policy, not copied from "last run status" alone.

Alternative considered: make last run terminal state the connection state. Rejected because it creates false green for success-with-gaps, false red for successful prior data with a later transient failure, and ambiguity after restart.

### Decision: Connection Health Uses Ordered Projection Plus Orthogonal Axes

The reference should compute connection health using a deterministic precedence order:

1. projection unreliable -> `unknown`;
2. owner-paused or never-run -> `idle`;
3. required attention open -> `needs_attention`;
4. backoff/give-up threshold crossed -> `blocked`;
5. backoff currently delaying retry -> `cooling_off`;
6. outbox/backlog/coverage/run evidence incomplete but useful -> `degraded`;
7. clean required coverage and current committed progress -> `healthy`;
8. fallback -> `unknown`.

The headline pill should remain small: `healthy`, `degraded`, `needs_attention`, `cooling_off`, `blocked`, `idle`, and `unknown`. `syncing`, `stale`, `gaps`, and outbox depth are not headline states; they are orthogonal axes or badges. The durable axes are freshness, coverage, attention, and outbox/work health.

Display severity and copy can be simpler than the internal evidence, but the projection rules must be explicit. Axes refine state; they do not replace it.

Alternative considered: make `syncing`, `stale`, `gaps`, and `not_configured` additional health states. Rejected because that turns each new evidence source into a new pill and recreates feature-list complexity. `not_configured` is setup status; `syncing` is activity; `stale` is freshness; `gaps` is coverage.

### Decision: Green Means Evidence-Backed Required Coverage

Green/healthy means the connection has durable evidence that all required requested streams or policy-defined coverage are collected or explicitly marked unsupported/unavailable as accepted coverage, checkpoints are committed safely, no required retryable backlog is pending, no required attention is active, and data freshness is within policy.

Yellow/degraded means useful data may exist, but there are known gaps, stale coverage, retryable backlog, optional/accepted gaps, cooldown, or uncertain projection freshness.

Red/blocked means the system cannot make progress without repair or owner action, or required work is dead-lettered/fatal.

Alternative considered: use green for any successful terminal run. Rejected because it caused the false-success class of failures that motivated this milestone.

### Decision: Coverage Is First-Class

Coverage is the structured answer to "what did we collect and what is missing?" It must be tracked by connection, stream/scope, and evidence boundary where possible. Coverage may include complete, partial, stale, deferred, unsupported, unavailable, retryable gap, terminal gap, inventory-only, and unknown.

Coverage is not a connector-specific note or a timeline string. It is the operator evidence that makes green/yellow/red honest.

Alternative considered: keep gaps and skips only on run timelines. Rejected because current connection health and schedules need to reason about them after the run is over.

### Decision: Work Is Bounded, Durable, And Policy-Governed

Any long-running executor path must obey a common reference executor contract:

- bounded memory: output must stream or batch; no unbounded child-output buffers for large backfills;
- durable pending work: retryable outbound effects must survive crash/restart;
- leases or active-run fencing: work cannot get permanently stuck in an `in_flight` state;
- destination-confirmed checkpoints: committed progress must be justified by acknowledged records/gaps;
- backpressure and queue bounds: failure to upload or hydrate must pause/defer rather than grow without limit;
- cancellation: active and queued work must be cancellable where practical;
- resource policy: CPU, RAM, disk, network, duration, and concurrency budgets must exist for heavy paths;
- restart reconstruction: after process/server/device restart, the console must rebuild pending/retrying/blocked/succeeded evidence from durable state.

This contract applies broadly, but each executor realizes it differently:

- local collectors use SQLite outbox, leases, checkpoints, backlog, and host-native service limits;
- browser/API connectors use active-run fencing, adaptive lanes/backoff, fixture/trace capture, and detail gaps;
- scheduler work uses non-overlap, backoff, manual-only policy, and persisted active/run history;
- read-model rebuilds use bounded rebuild/reconcile jobs and freshness metadata;
- remote browser surfaces use leases, capacity caps, and connection/run-scoped status.

Alternative considered: only fix local collectors. Rejected because the system crash and connector failures show the same unbounded-work class can appear in multiple executors.

### Decision: Attention Is A Durable State Transition

Owner action must be represented as structured attention, not unstructured progress text. An attention request should include:

- durable `attention_id` and `dedupe_key`;
- connection and run identity;
- kind and reason code;
- owner-readable message;
- action target such as dashboard form, remote surface, source app, local device, or external account;
- timeout/expiry;
- whether completion can be auto-detected;
- privacy classification and redaction rules;
- retry/ignore semantics;
- what happens on timeout, cancellation, or completion.

The lifecycle should be explicit: `open`, `acknowledged`, `in_progress`, `resolved`, `expired`, `cancelled`, or `superseded`. The model should use orthogonal axes rather than connector-specific variants: progress posture, owner action, response contract, sensitivity, and auto-detection mode. OTP, push approval, OAuth re-consent, Cloudflare/manual verification, missing device, expired local collector, broken selector, and unsafe schedule policy can all fit this model without assuming Playwright or n.eko.

Alternative considered: model only connector interactions. Rejected because local devices, schedules, and external app approvals also need owner attention.

### Decision: Notifications Deliver Attention, They Do Not Own State

PWA/Web Push should deliver actionable attention and important health transitions. It should not be a scheduler, connector transport, or source-change system. Notification policy should dedupe, rate-limit, and avoid prompting for states that are not actionable.

Alternative considered: push every failure or source event. Rejected because noisy alerts train owners to ignore the system and conflate event delivery with state authority.

### Decision: Runtimes And Surfaces Are Capacity, Not Source Identity

n.eko surfaces, local collectors, host browsers, Docker containers, device exporters, and future runtime hosts are execution capacity. Their health affects connection health, but they are not the owner's source identity. A connection may require one or more runtime capabilities to make progress.

Alternative considered: expose runtime rows as the primary console. Rejected because owners think in accounts/sources; runtime detail belongs in secondary diagnostics.

### Decision: Dashboard Read Models Are Derived Evidence Views

Operator console read models are allowed and desirable for speed. They must be rebuildable from canonical evidence, freshness-labeled, and unable to silently replace canonical run/record/work evidence.

Alternative considered: compute every dashboard card live from canonical tables. Rejected because it already produced unacceptable dashboard latency at corpus size.

### Decision: The Milestone Is Not "Every Connector Green"

The milestone is complete when the system can honestly operate every configured source class through a connection-centered model without false success, silent data loss, unbounded work, or opaque owner action. Individual connector-green work continues after and on top of this substrate.

Alternative considered: require all connectors to be green. Rejected because that turns a reliability construction milestone into endless source-specific selector/account work.

## Risks / Trade-offs

- **Risk:** The state model becomes too abstract for owners.  
  **Mitigation:** Render simple labels and CTAs while keeping the detailed evidence model inspectable one level down.

- **Risk:** Strict green semantics make the system look less successful.  
  **Mitigation:** Prefer honest degraded/success-with-gaps over false green; show useful collected data and the exact recovery path.

- **Risk:** Executor guarantees broaden scope.  
  **Mitigation:** Implement common requirements where they prevent known failure classes; keep connector-specific correctness out of this milestone unless needed to prove the substrate.

- **Risk:** Resource limits slow first backfills.  
  **Mitigation:** Make backfills resumable and visible rather than fast and fragile.

- **Risk:** Attention modeling overfits current ChatGPT/Chase flows.  
  **Mitigation:** Keep attention generic: action target, timeout, auto-detection, privacy, and recovery semantics.

- **Risk:** Reference-only mechanics leak into PDPP Core.  
  **Mitigation:** Keep requirements under reference architecture and explicitly classify Collection Profile candidates separately.

## Migration Plan

1. Finalize this milestone spec and acceptance suite after prior-art worker review.
2. Add/normalize connection health projection inputs from existing durable evidence.
3. Implement the projection algorithm and dashboard rendering against current evidence.
4. Finish local collector durable runner integration enough to satisfy bounded-work requirements for Claude/Codex-scale sources.
5. Add resource and restart acceptance tests across local collector, scheduler, read model rebuild, and at least one browser/API connector path.
6. Wire structured attention and notification policy into connection health.
7. Remove temporary legacy local queue migration paths after current local queues are imported or intentionally discarded.
8. Run full milestone validation and update this change with any learned design deltas.

Rollback should preserve canonical evidence and only disable newly derived projections or executor paths. Rollback must not delete outbox rows, backlog/gap evidence, run timelines, or canonical records automatically.

## Acceptance Checks

- A dashboard owner can inspect every configured connection and see one current state, coverage summary, last durable progress, pending work, and next action.
- A successful connector run with required gaps renders degraded/success-with-gaps, not healthy.
- A retryable failure with backoff renders cooling-off with next attempt and manual-run semantics.
- A required OTP/re-consent/manual-browser action renders needs-attention with a concrete action target and expiry.
- An active run renders activity/syncing as a badge without replacing the health pill.
- A stale but otherwise clean connection renders freshness as a stale axis without inventing a separate stale health state.
- A local collector crash after enqueue and before upload acknowledgement recovers pending work after restart.
- A large local collector backfill does not require buffering all connector output in memory.
- A read-model rebuild failure leaves canonical evidence intact and marks the projection stale/failed.
- A server restart reconstructs active/pending/retrying/blocked state from durable evidence.
- A remote browser surface capacity failure degrades the affected connection without changing source identity.
- Secret-bearing diagnostics remain redacted in timeline, dashboard, push, and CLI/status output.

## Open Questions

- Exact state precedence may need revision after worker prior-art reports.
- The minimal first implementation may not satisfy every executor guarantee for every connector; tasks must identify which paths are milestone blockers versus follow-up hardening.
- The boundary between `degraded` and `cooling_off` should be checked against scheduler and connector-health prior art before finalizing.
