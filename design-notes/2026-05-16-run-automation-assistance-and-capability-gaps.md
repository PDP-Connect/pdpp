# Run Automation Assistance And Capability Gap Semantics

Status: decided-promote
Owner: reference implementation owner
Created: 2026-05-16
Updated: 2026-05-16
Related: openspec/changes/add-connector-refresh-policy-controls, openspec/changes/define-run-assistance-state-contract, openspec/changes/add-dashboard-web-push-notifications, openspec/changes/gate-unsafe-connector-schedules, openspec/changes/auto-enroll-eligible-connector-schedules, openspec/changes/add-connector-detail-gap-recovery

## Question

What is the smallest SLVP-ideal design that makes connector automation, human assistance, schedules, notifications, and connector coverage status honest without inventing a large workflow system?

## Context

The reference implementation already has significant mechanism:

- Connector refresh-policy hints and schedule controls.
- Unsafe schedule gating.
- Auto-enrollment for eligible background-safe connectors.
- Run assistance state work.
- Dashboard Web Push and ntfy notification mechanisms.
- Detail-gap recovery for partial data.
- Known-gaps storage and connector health projection.

The remaining design problem is not "schedules" alone. Schedules exposed the issue, but the same policy applies to manual runs, retries, webhook-triggered runs, and any run that may need owner assistance.

Slack exposed a separate but related honesty problem: a connector can succeed exactly as configured while still declaring data that is not available in the current collection mode. Today those expected limitations are stored as known gaps and can make the connector appear degraded.

## Stakes

If we under-design this, the reference will keep surprising the owner:

- Background jobs may ping at bad times.
- Manual-only connectors may look broken when they are merely unscheduled.
- A connector may be yellow because it is honestly incapable of a stream in the selected mode, not because a useful run failed.
- Dashboard copy may conflate "needs your help now" with "will run when you ask" or "waiting for retry".

If we over-design it, we risk a policy DSL, custom notification rules engine, or connector-specific state taxonomy that is harder to explain than the problem.

## Current Leaning

Promote two narrow designs, not one large umbrella feature.

### 1. Run Automation And Assistance Policy

This design answers: "May a run start, and may PDPP ask the owner for help?"

Every run request has a trigger kind:

- `manual`
- `scheduled`
- `retry`
- `webhook`

Trigger kind is metadata. It does not create separate execution paths.

Every run request passes through the same small policy gate:

- Can this connector run unattended in this deployment?
- If not, should the request be rejected, queued for owner action, or started only from a manual owner gesture?
- If the connector later needs help, is PDPP allowed to notify the owner?
- Which notification channels are allowed?
- Is the event action-required or informational?
- Does quiet-hours suppression apply?

The essential user-facing distinction is:

- **Unattended**: may run in the background and should not need owner help.
- **Assisted**: may run automatically, but may notify the owner if an expected assistance state appears.
- **Ask-before-run**: may be scheduled as intent, but the schedule should notify/ask before starting rather than launching into a likely manual step.
- **Manual-only**: never starts from background automation.

This should not become a connector-specific state enum. `chatgpt_push_pending`, `chase_otp_pending`, and `cloudflare_pending` are incidental website details. The durable model is still:

- progress posture: running, blocked, waiting retry;
- owner action: none, act elsewhere, provide value, operate attachment;
- response obligation: none or response required;
- notification urgency: action-required or informational.

Quiet hours should be minimal:

- Dashboard inbox is always durable.
- Web Push / ntfy require explicit per-channel opt-in.
- Informational notifications obey a single local quiet window.
- Action-required notifications bypass app-level quiet hours but still respect OS/browser notification controls.

This is not a full workflow engine, cron DSL, or notification-rules product. It is the minimum model needed to make automatic connectors safe and assisted connectors explicit.

### 2. Capability, Selection, And Gap Severity

This design answers: "Did the connector fail, or was the missing data never available/selected?"

Keep these facts separate:

- **Capability**: what the connector and selected mode can collect.
- **Selection**: what the owner/run asked to collect.
- **Outcome**: what happened in this run.

Add machine-readable stream availability to connector manifests:

- `supported`
- `unsupported_in_mode`
- `experimental`
- `deprecated`

Streams marked `unsupported_in_mode` should not be requested by default for that mode. If explicitly requested, the connector may emit an informational or actionable gap depending on whether the owner knowingly opted in.

Known gaps need a severity/reason class:

- `informational`: expected limitation, user-disabled, out of scope.
- `transient`: rate limit, temporary upstream pressure, retry backlog.
- `actionable`: selected data was not delivered and needs operator/developer action.
- `recoverable`: detail-gap or backlog semantics with a known recovery path.

Connector health should go yellow only for actionable/transient/freshness/auth problems, not for informational capability limitations.

For Slack specifically:

- `stars`, `reminders`, and possibly `user_groups` are reasonable optional Slack Web API fallback candidates.
- `dm_read_states` should stay deferred because it is ephemeral, expensive, and low portability value.
- Default slackdump mode should be green if the only missing streams are expected slackdump-mode limitations.

## Promotion Trigger

Promote before further implementation that changes:

- schedule eligibility or auto-enrollment semantics;
- notification/quiet-hours behavior;
- run assistance event shape;
- connector manifest stream availability;
- `SKIP_RESULT` reason/severity semantics;
- connector health color/status projection.

## Decision Log

- 2026-05-16: Decided this is two narrow design seams: run automation/assistance policy and capability/selection/gap severity. Avoid a large workflow engine or connector-specific scenario taxonomy.
- 2026-05-16: Decided schedules are one trigger kind, not the design root. Manual runs, retries, and webhooks must pass through the same policy model.
- 2026-05-16: Decided Slack's expected slackdump-mode limitations should not make the connector yellow by default.

