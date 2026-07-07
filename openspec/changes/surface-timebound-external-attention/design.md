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

## Alternatives

- **Treat all `act_elsewhere` rows as action-needed.** Rejected because it would
  alarm for connector-authored informational progress.
- **Require `response_contract:"response_required"` for health relevance.**
  Rejected because external approvals are intentionally observable by the
  connector and do not need a PDPP-submitted response.
- **Special-case the affected connector.** Rejected because the assistance axes
  already express the generic product concept.

## Acceptance Checks

- A time-bound external approval projects `needs_attention` with a structured
  next action.
- An unbounded external progress notice leaves an otherwise healthy connection
  healthy and creates no CTA.
- Expired rows remain non-health-relevant.
