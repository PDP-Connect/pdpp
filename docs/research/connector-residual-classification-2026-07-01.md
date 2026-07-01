# Connector residual classification - 2026-07-01

Status: current RI-owner residual classification after the missing-`START`
runtime fix shipped to the live reference stack.

## Current shared evidence

- Live revision: `v0.18.12-51-g5c3108d11`.
- `controller_active_runs` was empty after deploy and schedule resume.
- The live polyfill runtime now fails closed when stdin closes before `START`:
  it emits a failed `DONE` with no records and exits non-zero instead of leaving
  a hot connector child alive.
- `connector_attention_records` had no current open, in-progress, or
  acknowledged rows when checked after deploy.
- The latest `connector_exit_without_done` rows for scheduled sources were
  produced before the fixed runtime was deployed. They are stale evidence until
  the next run for that source proves a new failure.

## Classification

### Runtime residuals

The cross-connector `connector_exit_without_done` class is closed as a runtime
bug. New occurrences after `5c3108d11` should be treated as a new regression,
not folded into the old incident.

### ChatGPT

The primary scheduled ChatGPT connection is repaired and scheduled. The durable
proof and residual risk are recorded in
`docs/research/chatgpt-session-reuse-regression-closeout-2026-06-29.md`.

A second older ChatGPT connection remains paused and unrepaired. That is an
owner-data cleanup decision, not proof that the current ChatGPT schedule is
broken. Do not use the stale duplicate to reopen the ChatGPT auth/session
regression unless the primary scheduled connection fails the same path again.

### Amazon

Amazon no longer has an active runtime/liveness blocker in this ledger. The
remaining issue is collection-quality: detail completeness and retryable gaps
should be investigated with connector fixtures, parser/classifier evidence, and
provider-page snapshots. This is connector-specific backlog, not a shared
source-actionability or runtime-startup problem.

### Chase

Chase remains a connector-specific coverage/backlog issue. The previous QFX
file-type selector fix and deploy should be evaluated by a Chase retry when an
owner-authenticated run is available. Until then, this is not closed as a
collection-quality item, but it is no longer part of the shared UI/actionability
or missing-`START` incidents.

### USAA

USAA remains provider-login-flow sensitive. The known symptom was a login page
where the password field did not appear after the member-id step. That should
be handled as a connector fixture/parser/update lane if it recurs; it is not
evidence of a shared actionability taxonomy failure.

### Reddit

Reddit's current residual is freshness/manual refresh, not a current runtime
blocker. A fresh manual run can close or reclassify it. The first-click/read
error the owner observed belongs to the source-read reliability surface, not the
Reddit connector itself, unless a fresh run produces Reddit-specific failures.

### Local collectors

Local collector outbox warnings are owned by the local collector recovery path.
They are separate from browser/API connector collection and should not be
collapsed into account-credential repair language.

## Closeout rule

This closes the umbrella "connector residuals" item in the RI-owner retroactive
ledger. Specific connector quality improvements remain legitimate work, but
they should be tracked as scoped connector lanes with their own fixture evidence
and acceptance checks. Do not reopen the umbrella ledger unless a shared
substrate issue affects multiple connectors again.
