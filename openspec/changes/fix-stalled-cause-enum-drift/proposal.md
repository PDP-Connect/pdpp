## Why

An independent judge review of commit `68bdc6fba` (which added the
`stale_heartbeat` stalled-outbox cause, closing the gap where a `starting`/
`retrying` local-collector heartbeat sat `active` forever with no staleness
check) found the code change was correct but landed a ratified-spec
divergence: `openspec/specs/reference-connection-health/spec.md`'s
"Stalled local-device outbox SHALL name its cause class" requirement
(spec.md:452-482) closes the cause enum at exactly `state_read_failed`,
`dead_letter_backlog`, `stale_pending` — it never named `transient_upload_failure`
(implemented and tested in code before this session) or the new
`stale_heartbeat`, and its precedence-ordering sentence names only three of
the five causes the implementation actually ranks. Landing code with a known
cause the ratified spec's own enum forbids is a drift this task must not
knowingly leave in place.

## What Changes

- Widen the `OutboxStalledCause` enum named in the "Stalled local-device
  outbox SHALL name its cause class" requirement from three to all five
  values the implementation classifies: `state_read_failed`,
  `dead_letter_backlog`, `stale_pending`, `stale_heartbeat`,
  `transient_upload_failure`.
- Correct the precedence-ordering sentence to name the full rank order the
  implementation already enforces (`server/connector-outbox-axis.ts`
  `STALLED_CAUSE_RANK`): `dead_letter_backlog` > `state_read_failed` >
  `stale_pending` > `stale_heartbeat` > `transient_upload_failure`.
- Add two scenarios: a `transient_upload_failure` classification scenario
  (already-implemented, already-tested behavior that had no spec scenario at
  all) and a `stale_heartbeat` classification scenario (this session's new
  behavior).

This is a spec-only, documentation-of-existing-behavior change. No production
code changes beyond the already-reviewed and already-committed `68bdc6fba`
staleness fix. No new behavior, no altered precedence, no altered copy — the
delta below states in the ratified spec exactly what the implementation
already does today.

## Impact

- Affected spec: `reference-connection-health`
  (Requirement: "Stalled local-device outbox SHALL name its cause class")
- Affected code: none (documentation-only correction; the code this spec
  describes was already implemented and tested prior to and within
  `68bdc6fba`)
