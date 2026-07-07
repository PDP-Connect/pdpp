## Context

Structured run assistance already separates three axes:

- `progress_posture`: whether the run is blocked, running, or waiting.
- `owner_action`: whether the owner can do something useful.
- `response_contract`: whether PDPP needs a submitted owner response.

External approvals such as app-push approval intentionally use
`running + act_elsewhere + response_contract:none`: the owner acts outside PDPP,
and the connector keeps polling until it observes success or the request expires.

The health projection had one remaining over-broad silence rule: every
nonblocking `act_elsewhere` row was treated as informational. That was right for
unbounded progress notices, but wrong for time-bound external actions. A current
expiry means the owner has a live window to act, and missing that window can
change the run outcome.

The same live path exposed the runtime half of the contract: `expires_at` was
persisted on the attention row, but no-response `ASSISTANCE` did not own a timer.
If a connector failed to emit `ASSISTANCE_STATUS` after its declared window, the
run stayed active indefinitely.

## Decision

`isHealthRelevant` treats an attention row as owner-actionable when it is:

- non-terminal,
- not expired at the projection time,
- `owner_action: "act_elsewhere"`, and
- has `expires_at`.

The predicate still suppresses unbounded
`running + act_elsewhere + response_contract:none` rows. Those rows remain
appropriate for passive progress where the owner cannot improve the immediate
outcome.

For no-response `ASSISTANCE` rows with `timeout_seconds`, the runtime starts a
per-assistance timer. If the connector closes the assistance first, the timer is
cleared. If the timer fires first, the runtime terminates the connector child,
expires the structured attention row via `run.assistance_timed_out`, and records
the run terminal as `failed` with reason `assistance_timed_out`.

Startup reconciliation also closes any open attention row whose `run_id` already
has a terminal spine event. This covers both the normal restart path, where the
controller emits `run.failed` for an abandoned active run, and the self-healing
path where a stale attention row survived after its active-run row was already
cleared. The terminal spine event is the authority; the dashboard must not keep
an owner-action CTA alive after the run can no longer observe the action.

## Alternatives

- **Treat all `act_elsewhere` rows as action-needed.** Rejected because it would
  alarm for connector-authored informational progress.
- **Require `response_contract:"response_required"` for health relevance.**
  Rejected because external approvals are intentionally observable by the
  connector and do not need a PDPP-submitted response.
- **Special-case the affected connector.** Rejected because the assistance axes
  already express the generic product concept.
- **Rely on connector-authored timeout logic.** Rejected because the runtime
  already accepts and persists `timeout_seconds`; once the reference exposes that
  deadline to owners, the reference must enforce the deadline when the connector
  does not.

## Acceptance Checks

- A time-bound external approval projects `needs_attention` with a structured
  next action.
- An unbounded external progress notice leaves an otherwise healthy connection
  healthy and creates no CTA.
- Expired rows remain non-health-relevant.
- A connector that emits time-bound no-response assistance and never closes it
  terminals as `assistance_timed_out` and releases the active-run slot.
- An open attention row for a terminal run is transitioned to a terminal
  lifecycle during startup reconciliation and disappears from owner-action
  projections.
