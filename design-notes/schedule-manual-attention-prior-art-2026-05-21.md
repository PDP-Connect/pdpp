# Schedule And Manual-Attention Prior Art

Status: researching
Owner: RI owner
Created: 2026-05-21
Updated: 2026-05-21
Related: design-notes/full-context-refresh.md, openspec/changes/publish-pdpp-local-collector, openspec/changes/introduce-local-collector-runner

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

- Temporal schedules model overlap, catchup windows, paused state, and `pause_on_failure`, which supports treating schedule execution policy as separate from workflow logic: https://api-docs.temporal.io/
- GitHub Actions environments separate a triggered job from an approval gate and allow wait timers up to 30 days, which supports explicit human gates rather than pretending a paused job is still active execution: https://docs.github.com/en/actions/reference/deployments-and-environments
- Prefect automations separate triggers from actions and include notification, pause/resume schedule, suspend/resume run, and inferred action targets: https://docs.prefect.io/latest/guides/automations/
- Airbyte distinguishes ordinary sync notifications from “requires action,” repeated-failure warnings, and eventual sync disabling to avoid noisy broken schedules: https://support.airbyte.com/hc/en-us/articles/16960944967963-Notification-Types-for-Airbyte-Cloud
- Zapier distinguishes retry/autoreplay from repeated-error shutdown policy and lets teams override behavior per Zap, which supports per-connection policy rather than one global schedule behavior: https://help.zapier.com/hc/en-us/articles/14167175792909-Decide-how-your-Zap-handles-errors-with-advanced-settings

## Current Leaning

The reference implementation should promote an operator-attention policy, not a scheduler-specific patch:

- `schedule` expresses desired freshness and launch eligibility, not a guarantee that every tick starts a run.
- `run` remains a bounded execution attempt and can finish as `waiting_for_operator`, `failed_retryable`, `failed_not_retryable`, `succeeded`, or `succeeded_with_gaps`.
- `attention_request` is a durable, typed object keyed to connection/run/source, with reason, expiry, safe instructions, resume action, notification status, and quiet-hour/suppression metadata.
- Repeated failures or unresolved attention should pause or suppress the schedule for that connection after a threshold, while preserving a clear “run now / resume / re-enable” path.
- Local collectors should keep using host supervisors for timing; the server may surface “please run soon” intent and diagnostics, but should not pretend it controls a sleeping laptop or missing filesystem.

Strongest counterargument: this may introduce nouns before they are earned. The guardrail is to implement only the pieces required to prevent doomed scheduled runs and unclear operator attention, then let connector green-state work prove whether more policy is needed.

## Promotion Trigger

Promote this to OpenSpec before implementing any durable schedule/manual-attention behavior that changes run states, scheduler storage, dashboard status, notification semantics, or connector runtime contracts.

## Decision Log

- 2026-05-21: Local repo inventory found no existing schedule/manual-attention prior-art research artifact. Adjacent notes mention source-needs-attention and local collector state, but not a complete schedule policy.
- 2026-05-21: Captured initial prior-art findings. Current conclusion: scheduling, retries, and human attention should share a small policy model instead of being handled as separate one-off fixes.
