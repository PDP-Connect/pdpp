# reference-implementation-runtime — surface-run-handle-resolvability delta

## ADDED Requirements

### Requirement: Run handles SHALL remain resolvable until and after terminal state

Every run identifier returned by a control surface SHALL remain resolvable
to a status until and after the run reaches a terminal state — this covers
the run-now 202 acknowledgement, scheduler projections, and cancellation
acknowledgements. The reference implementation SHALL expose an owner-session route
`GET /_ref/runs/{run_id}` that resolves a run handle to its current status:
`active` while the controller's run bookkeeping owns the run or while a
`run.started` event exists without a terminal event, and the terminal status
(`completed` | `failed` | `cancelled` | `abandoned`) once a terminal spine
event exists — independent of the flight-state `controller_active_runs`
table, whose rows are deleted when a run settles. Failure information served
by the route SHALL be the typed, bounded fields already persisted on the
run's terminal spine event (terminal reason, failure origin, bounded
messages); the route SHALL NOT expose connector secrets or bearer tokens.

#### Scenario: Active run resolves

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for a run that has
  been acknowledged with 202 and has not yet reached a terminal state
- **THEN** the route SHALL respond 200 with status `active`
- **AND** it SHALL include the run id, trace id, connector identity, and
  started timestamp from the controller's active-run bookkeeping
- **AND** it SHALL link to the run's timeline route

#### Scenario: Terminal run resolves

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for a run whose
  terminal spine event has been recorded, regardless of how long ago the run
  settled
- **THEN** the route SHALL respond 200 with the terminal status derived from
  the run's most-recent terminal spine event
- **AND** it SHALL include the terminal reason when the terminal event
  carries one, started and completed timestamps, and — for failed or
  abandoned runs — a typed failure summary bounded to the fields persisted
  on the terminal event

#### Scenario: Unknown run id gets a typed 404

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for an identifier
  with no active-run bookkeeping and no spine events
- **THEN** the route SHALL respond with the reference error envelope and a
  typed `not_found` code naming the `run_id` parameter
- **AND** it SHALL NOT fall through to the transport's default unknown-route
  response

#### Scenario: Launch crash leaves the handle resolvable

- **WHEN** a run acknowledged with 202 crashes before the runtime records
  `run.started` (a throw in the launch path before the connector child
  spawns)
- **THEN** the controller SHALL record a typed terminal `run.failed` event
  with reason `launch_failed`, a bounded failure message, and zero records
- **AND** it SHALL log the failure with the run id and trace id
- **AND** `GET /_ref/runs/{run_id}` SHALL subsequently resolve the handle to
  status `failed`

#### Scenario: Post-spawn failures are not double-terminated

- **WHEN** a run's in-flight task rejects after the runtime has already
  recorded a terminal spine event for that run
- **THEN** the controller SHALL NOT emit a second terminal event for the run
