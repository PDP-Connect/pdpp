# Schedule And Manual-Attention Prior Art

Status: decided-promote
Owner: RI owner
Created: 2026-05-21
Updated: 2026-05-21
Related: design-notes/full-context-refresh.md, openspec/changes/define-schedule-manual-attention-policy, openspec/changes/publish-pdpp-local-collector, openspec/changes/introduce-local-collector-runner

## Question

What should the reference implementation do when scheduled collection needs a human, without turning schedules into a source of noisy, doomed, or misleading runs?

## Context

PDPP's reference implementation has several data-ingest shapes:

- Server-run API connectors that can usually run unattended.
- Server-run browser connectors that may need login, OTP, Cloudflare, or account review.
- Device-run local collectors that know local availability and filesystem change timing better than the server.
- Future source-signal and operator-attention paths.

The current scheduler is too run-centric. The SLVP target is an operator policy model that separates scheduled intent, bounded run attempts, waiting-for-operator states, retry/backoff, pause/disable, and notification delivery.

## Stakes

If schedules blindly launch runs, the system wastes compute, annoys the user, risks account friction, and reports confusing false failures. If schedules avoid all human-attention sources, fresh data decays. The ideal needs to be honest and predictable: tell the operator what is needed, avoid repeated doomed attempts, and keep resumable work safe.

## Prior Art

- Temporal schedules model overlap, catchup windows, paused state, and `pause_on_failure`, which supports treating schedule execution policy as separate from workflow logic: https://docs.temporal.io/schedule
- GitHub Actions environments separate a triggered job from an approval gate and allow wait timers up to 30 days, which supports explicit human gates rather than pretending a paused job is still active execution: https://docs.github.com/en/actions/reference/deployments-and-environments
- Prefect automations separate triggers from actions and include notification, pause/resume schedule, suspend/resume run, and inferred action targets: https://docs.prefect.io/v3/concepts/automations
- Fivetran distinguishes active, broken, delayed, incomplete, and paused connections; its Alerts surface separates errors that block syncing from warnings that may need fixing: https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors and https://fivetran.com/docs/getting-started/fivetran-dashboard/alerts
- Plaid Item repair uses explicit update/relink-style flows for credentials, MFA, revoked access, and required user action; `LOGIN_REPAIRED` lets apps silence repair messaging when the account heals elsewhere: https://plaid.com/docs/api/items/
- Zapier distinguishes retry/autoreplay from repeated-error shutdown policy and lets teams override behavior per Zap, which supports per-connection policy rather than one global schedule behavior: https://help.zapier.com/hc/en-us/articles/14167175792909-Decide-how-your-Zap-handles-errors-with-advanced-settings
- MDN's Web Push and Notifications guidance supports contextual opt-in, useful time-sensitive pushes, service-worker notifications on mobile, and treating permission/subscription/test status as separate facts: https://developer.mozilla.org/en-US/docs/Web/API/Push_API/Best_Practices and https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API

## Second-Pass SLVP Findings

- Account repair is its own lifecycle. A connection can have usable stale data while still being unhealthy for fresh sync. The dashboard must not show green only because old data exists or a notification was delivered.
- Attention should be a durable task with lifecycle and ownership, not a log line or notification read state. Useful lifecycle states include open, acknowledged, snoozed, resolved, superseded, and expired.
- Notification is delivery evidence attached to the task. The system should distinguish push not enabled, permission denied, stale subscription, test sent, test confirmed, delivery unknown, and delivery failed.
- Repeated schedule ticks should dedupe by connection, schedule, attention kind, and affected account or resource. Repeated observations should update `last_seen_at` and occurrence count rather than creating new prompts.
- Catch-up and backfill must be explicit. After attention clears, PDPP should not replay one run for every missed schedule tick. The default should be latest-only catch-up, with bounded or operator-triggered backfill only when a connector has true interval semantics and a safe recovery path.
- Concurrency and overlap policy are essential complexity. A schedule should have a per-connection concurrency key and an explicit overlap policy rather than letting overlapping runs race.
- Quieting notifications should not hide reality. Snooze or quiet hours may suppress delivery, but the connection remains non-green until the owner action is resolved or superseded.

## Current Leaning

The reference implementation should promote an operator-attention policy, not a scheduler-specific patch:

- `schedule` expresses desired freshness and launch eligibility, not a guarantee that every tick starts a run.
- `run` remains a bounded execution attempt and can finish as `waiting_for_operator`, `failed_retryable`, `failed_not_retryable`, `succeeded`, or `succeeded_with_gaps`.
- `attention_request` is a durable, typed object keyed to connection/run/source, with reason, expiry, safe instructions, resume action, notification status, and quiet-hour/suppression metadata.
- Repeated failures or unresolved attention should pause or suppress the schedule for that connection after a threshold, while preserving a clear "run now / resume / re-enable" path.
- Clearing an attention request should enable at most one latest-state catch-up run by default. Any broader backfill should be explicit, bounded, and connector-declared.
- Local collectors should keep using host supervisors for timing; the server may surface “please run soon” intent and diagnostics, but should not pretend it controls a sleeping laptop or missing filesystem.

Strongest counterargument: this may introduce nouns before they are earned. The guardrail is to implement only the pieces required to prevent doomed scheduled runs and unclear operator attention, then let connector green-state work prove whether more policy is needed.

## Promotion Trigger

Promote this to OpenSpec before implementing any durable schedule/manual-attention behavior that changes run states, scheduler storage, dashboard status, notification semantics, or connector runtime contracts.

## Decision Log

- 2026-05-21: Local repo inventory found no existing schedule/manual-attention prior-art research artifact. Adjacent notes mention source-needs-attention and local collector state, but not a complete schedule policy.
- 2026-05-21: Captured initial prior-art findings. Current conclusion: scheduling, retries, and human attention should share a small policy model instead of being handled as separate one-off fixes.
- 2026-05-21: Second-pass SLVP research confirmed the existing OpenSpec direction and added one normative gap: no unbounded replay of missed schedule ticks after attention clears. Promote this note into `openspec/changes/define-schedule-manual-attention-policy`.
