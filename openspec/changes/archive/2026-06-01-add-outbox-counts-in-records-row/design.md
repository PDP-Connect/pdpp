# Design

## Context

`add-outbox-counts-in-connection-summary` (archived/merged) did the hard part: it rolled the device-reported `outbox_diagnostics` into `LocalDeviceProgress.outbox_counts` (trusted sources only, non-negative integers + optional ISO `oldest_pending_at`, owner-only, `null` for scheduler-managed rows) and surfaced a count-backed scale line on the connector **detail** remediation panel via `summarizeOutboxStallRemediation` + `formatOutboxCountScale`.

It explicitly deferred the records-**list** row to avoid noisy healthy-row badges. The records-list row already renders, for a stalled local-device connection, a `NextStepGuidanceRow`:

- label "Check the collector host", danger tone, and
- a `<Link href={detailHref}>` to the connection detail page (where the remediation panel and host command live).

That guidance comes from `deriveConnectionNextStep`, which fires its stalled branch on `health.axes.outbox === "stalled"` and returns `null` for healthy/idle/unknown. The single gap: the guidance states the stall qualitatively, with no scale.

## Decision

Surface the scale on the row by extending the existing stalled guidance — not a new chip, not a new row, not a new data source:

1. **Helper (`connection-evidence.ts`).** `NextStepGuidance` gains a `scale: string | null` field. `deriveConnectionNextStep` accepts an optional `localDeviceProgress` and, **only on the stalled-outbox branch**, sets `scale` via the existing private `formatOutboxCountScale(localDeviceProgress?.outbox_counts)`. Every other guidance return sets `scale: null`. This reuses the detail panel's exact count-formatting rule (positive stuck-work categories only; `null` when none are positive), so the row and detail panel can never disagree on what "stuck" means.

2. **Row (`connector-row.tsx`).** Thread `overview.localDeviceProgress ?? null` into the `deriveConnectionNextStep` call (the same object already gates `supportsOwnerSync`). Render the cue inside the existing `NextStepGuidanceRow` `<Link>` — a `tabular-nums` caption "Stuck on the device: {scale}" — only when `guidance.scale` is set. Because the whole row is already a link to `detailHref`, the cue points at the detail remediation panel for the host command; it invents no remote fix.

## Why the stalled branch is the only gate

`deriveConnectionNextStep` returns `null` for healthy/idle/unknown and never reaches the stalled branch for active/idle/unknown outboxes. `formatOutboxCountScale` returns `null` when no stuck-work category is positive. So the cue can appear only when: the outbox axis is `stalled` AND the trusted-source rollup reports at least one positive `pending`/`retrying`/`stale_leases`/`dead_letter`/`backlog_open`. succeeded/total are never shown — they are not remediation-relevant. Scheduler-managed rows carry no `local_device_progress`, so `scale` is `null` for them.

## Voice

Operator-console voice. "Stuck on the device: 12 pending · 2 dead-letter" is a factual count of retryable work the local collector has not drained. The row continues to point at the host, not a dashboard button — the reference cannot drain a device-local outbox remotely. No connector-health overclaim; the cue describes outbox backlog scale, nothing about coverage or source health.

## Alternatives Considered

- **A standalone count chip/badge next to the status pill.** Rejected: a second visual element competes with the axis-chip strip and the health pill, and risks reading as a health badge on its own. Folding the scale into the one guidance row that already exists for a stalled outbox keeps the row to a single stalled affordance and reuses its detail link.
- **Surface counts on every row (including healthy).** Rejected: directly violates the prior slice's "keep healthy/idle/active/unknown quiet" constraint and the records-row noise stop-condition. The data is owner-only and already carried; the console only renders it where it changes a remediation decision.
- **A new row-level helper separate from `deriveConnectionNextStep`.** Rejected: the stalled-row guidance and its detail link already live in `deriveConnectionNextStep`/`NextStepGuidanceRow`. A parallel helper would duplicate the stalled-axis gate and risk drift from the detail panel's formatting.
- **Re-derive the outbox axis or counts on the row.** Out of scope: axis derivation and the rollup are the reference's job and already done. This slice only renders an already-gated, already-rolled-up value.

## Out Of Scope

- Any change to the reference projection, device telemetry, heartbeat ingest contract, storage, or grant-scoped read APIs.
- Re-deriving `axes.outbox` or the count rollup on the client.
- Count cues on non-stalled rows or on the headline pill.
- A browser/visual regression harness (absent from this repo). Gating and rendering are proven by pure helper tests and structural source assertions; the residual is an owner-live visual confirmation.

## Acceptance Checks

- The records-list row renders a count-backed scale only on the stalled-outbox guidance, only when the summary carries a non-null `outbox_counts` with at least one positive stuck-work category.
- Healthy / idle / active / unknown / scheduler-managed / no-count rows render no count cue or numeric outbox badge.
- The cue renders inside the existing guidance `<Link>` to `detailHref` — the row points at the detail remediation panel, not a new remote fix.
- The cue omits zero categories and never shows succeeded/total.
- `pnpm --dir apps/console run types:check` and `run check`, targeted connection-evidence / connector-row tests, `openspec validate add-outbox-counts-in-records-row --strict`, `openspec validate --all --strict`, and `git diff --check` pass.
