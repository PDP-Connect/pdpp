## Context

The user's goal is freshness by default, but not at the cost of bad human experience or platform lockouts. Email can usually refresh frequently. Banking connectors may need OTP or short-lived browser sessions and should avoid background spam. Other sources sit between those extremes.

Prior art supports a productized scheduling surface:

- Fivetran lets users set connector sync frequency, manual mode, and delayed/rescheduled syncs when a prior sync overlaps.
- Airbyte supports manual and cron-style schedules, with platform-specific max-frequency constraints.
- Kubernetes CronJob separates schedule from concurrency policy and missed/deadline handling.

PDPP's reference already has:

- `connector_schedules` persistence with interval/jitter/enabled
- `_ref` schedule mutation routes
- run timelines, interactions, active-run locks, retries, and deterministic-failure disabling
- manifest `capabilities.human_interaction`

The missing layer is policy: why this connector should run frequently, rarely, only on demand, or only when a human is available.

## Design

Add a `capabilities.refresh_policy` manifest hint for reference/polyfill connectors. Initial shape:

```json
{
  "recommended_mode": "automatic" | "manual" | "paused",
  "recommended_interval_seconds": 900,
  "minimum_interval_seconds": 300,
  "maximum_staleness_seconds": 3600,
  "interaction_posture": "none" | "credentials" | "otp_likely" | "manual_action_likely",
  "session_lifetime_seconds": 1800,
  "rate_limit_sensitivity": "low" | "medium" | "high",
  "bot_detection_sensitivity": "low" | "medium" | "high",
  "background_safe": true,
  "rationale": "Short owner-readable explanation."
}
```

The shape should stay modest. It is a scheduling hint, not a connector policy DSL.

### Dashboard UX

Add a scheduling/freshness view that lets the owner:

- see every connector with record count, last success, last attempt, active run, next due, and schedule state
- see the connector's recommended mode/cadence and why
- choose manual, paused, every N, or advanced cron later if needed
- run now
- pause/resume/delete a schedule
- understand when a connector requires credentials/OTP/manual action
- avoid scheduling high-friction connectors aggressively by accident

The UI should make these common defaults easy:

- Gmail/Slack/local-file history: frequent or moderate automatic refresh
- YNAB/API-token sources: automatic daily or hourly depending on API cost
- banks/browser-auth: manual or low-frequency with clear human-attention copy
- bot-sensitive platforms: conservative automatic or manual until evidence improves

### Scheduler semantics

The scheduler should:

- prevent overlapping runs
- apply jitter to automatic schedules
- avoid repeated background attempts when a connector needs human interaction
- back off on rate-limit/bot-detection-like failures
- expose skipped/delayed decisions in run or schedule history
- keep manual "run now" available even when automatic schedule is paused

### Protocol posture

This is reference/runtime behavior. `refresh_policy` is a first-party manifest hint for the reference and connector authoring. It should not be documented as core PDPP protocol normativity in this tranche.

If the team later wants portable connector operational metadata, promote a narrowed vocabulary into the appropriate Collection Profile or companion spec after observing the reference.

## Alternatives Considered

- Fixed interval only: already exists and is too poor for OTP/manual browser connectors.
- Always keep data as fresh as possible: attractive, but it can create bad UX and platform suspicion for banks and browser-heavy platforms.
- Manual-only for everything: safe but defeats the value of a living personal data substrate.
- Full cron first: useful later, but most users need mode + cadence + rationale first.

## Acceptance Checks

- Owners can configure schedules from a connector list without editing env vars or raw JSON.
- First-party connectors expose honest recommended refresh posture.
- High-friction connectors do not repeatedly request OTP/manual attention in the background.
- Schedule projections explain last success, last failure, next due, and policy-driven skips.
- Protocol-candidate metadata is documented as reference/experimental, not finalized PDPP normativity.

## Prior Art

- Fivetran sync overview: https://fivetran.com/docs/core-concepts/syncoverview
- Fivetran connection API frequency/manual mode: https://fivetran.com/docs/rest-api/api-reference/connections/create-connection
- Airbyte cron scheduling: https://support.airbyte.com/hc/en-us/articles/17224581835803-Cron-Expressions-for-Custom-Sync-Timing
- Kubernetes CronJob: https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
