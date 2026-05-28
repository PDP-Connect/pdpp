## Context

The prior-art note in `design-notes/schedule-manual-attention-prior-art-2026-05-21.md` points to a consistent pattern across Temporal, GitHub Actions environments, Prefect, Fivetran, Plaid, Zapier, and MDN's notification guidance: schedules, execution attempts, retry policy, approval or attention gates, notification delivery, and pause/suppression policy are separate concepts.

PDPP has the same shape. Server-run API connectors may run unattended, server-run browser connectors may need login or account intervention, and device-run local collectors may depend on host availability that the server cannot control. The reference implementation should stop treating scheduled freshness as permission to repeatedly launch doomed runs when the owner must act first.

The second-pass SLVP finding is that catch-up policy is not optional. If an owner-action gate is unresolved for several schedule ticks, clearing the gate must not silently replay one run per missed tick. The default policy should be latest-only catch-up, with bounded or operator-triggered backfill only when a connector has true interval semantics and a safe recovery path.

## Decision

Define the SLVP policy around five nouns:

- `schedule`: desired freshness and launch eligibility for a connection/source. It records when the reference would like data to be refreshed, not a promise that every due instant starts a run.
- `run`: a bounded attempt to refresh data. A run can finish as successful, retryable failure, terminal failure, successful-with-gaps, or waiting-for-operator; it must not remain active solely because human attention is required.
- `attention_request`: a durable, typed object keyed to connection and source, with optional run evidence. It carries the reason, safe instructions, expiry or review time, resume action, notification state, and quiet-hour/suppression metadata.
- `notification`: delivery policy and state for notifying an owner or operator about an attention request. Notification is part of the policy, not an incidental log line.
- `suppression`: per-connection control that prevents repeated automatic attempts while a materially equivalent attention request is unresolved.

The reference scheduler should check unresolved attention before launching a scheduled run. If an equivalent unresolved request exists, the scheduler records that the schedule was skipped or suppressed for attention rather than creating another run. If attempts continue to encounter the same owner-action requirement, the connection schedule is paused or suppressed according to policy until the operator resolves, resumes, or explicitly re-enables it.

When attention is resolved, the scheduler should not replay an unbounded backlog of missed schedule ticks. It should make the connection eligible for the next normal launch and may start at most one latest-state catch-up run by default. Broader backfill must be explicit, bounded, and connector-declared.

## Boundaries

This change specifies the contract, not a host-control mechanism. Local collectors and host supervisors remain responsible for local timing, filesystem availability, and waking a device process. The server may surface desired freshness, diagnostics, and "please run soon" intent for local collectors, but it must not pretend it can schedule work on a sleeping laptop or unavailable filesystem.

This change also does not decide final API field names beyond the normative shape needed to prevent silent retry storms. Implementation may choose storage names, route placement, and UI affordances as long as the policy remains durable, typed, suppressible, and resumable.

## Alternatives Considered

- Keep retrying on every due tick and rely on logs. This is rejected because it creates noise, wastes work, and hides the fact that owner action is the blocker.
- Mark the schedule disabled immediately on the first manual-attention run. This is too blunt because transient login, OTP, or review flows may resolve quickly and should preserve an explicit resume path.
- Model manual attention as only a run status. This loses notification, suppression, quiet-hour, and per-connection deduplication semantics once the run is no longer active.
- Replay every missed schedule tick after attention clears. This is rejected because most PDPP schedules express freshness intent, not interval obligations. Forcing a backlog can create redundant work, duplicate prompts, source-rate pressure, and stale UI claims.

## Acceptance Checks

- A due schedule with an unresolved equivalent attention request does not start another automatic run.
- A run that needs owner action terminates as a bounded attempt and creates or updates a durable typed attention request.
- Repeated unresolved attention for one connection is paused or suppressed without affecting unrelated connections.
- Resolving attention does not launch unbounded catch-up work for every missed tick.
- Owners can see the reason, safe next action, notification status, and resume or re-enable path.
- Local collector behavior remains described as host-supervisor-owned, not server-owned.
