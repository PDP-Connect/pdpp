## ADDED Requirements

### Requirement: Local-device collection verdict SHALL be terminal collection evidence

The connection-health projection SHALL recognize a local-device collection-succeeded verdict as terminal collection evidence equivalent to a succeeded spine run, so that a local-device-backed connection whose device-side evidence is fully green can project `healthy`.

The verdict SHALL be established only when all of the following hold for a local-device-backed connection: the outbox axis is `idle` derived from trusted heartbeat evidence (active device, active source, not revoked); durable `coverage_diagnostics` prove a `complete` coverage axis; and freshness is `fresh`. The freshness gate keeps the change purely additive — a drained collector with complete coverage but no satisfied freshness policy keeps `CollectionSucceeded` unknown and remains `idle` exactly as before; only the fully-green case is upgraded. When the verdict holds and no run-derived collection verdict exists, the projection SHALL treat the `CollectionSucceeded` condition as satisfied (`status = true`) with a local-device origin.

A run-derived collection verdict SHALL always take precedence. When a terminal spine run exists for the connection, the projection SHALL use the run outcome and SHALL NOT let device evidence override it. The verdict SHALL apply only to local-device-backed connections; scheduler-managed connections SHALL NOT receive it.

The verdict SHALL NOT relax any other gate to `healthy`. A local-device connection with no satisfied freshness policy SHALL remain `idle` rather than `healthy` or `unknown`. A stalled outbox, dead letters, retryable backlog, a stale lease, a stale heartbeat, a degrading or `unknown` coverage axis, open required attention, blocked credentials or runtime, and an empty outbox with no coverage diagnostics SHALL each keep the connection out of `healthy` exactly as before. Absence of trusted device evidence SHALL NOT establish the verdict.

#### Scenario: Drained local collector with complete coverage and fresh heartbeat projects healthy

- **WHEN** a local-device-backed connection has a trusted, healthy, fully-drained outbox (axis `idle`), durable `coverage_diagnostics` proving `complete` coverage, and freshness `fresh` because a recent heartbeat satisfies a declared refresh policy
- **THEN** the projection SHALL report `CollectionSucceeded` with status `true` and headline state `healthy`

#### Scenario: Drained local collector with complete coverage but no freshness policy stays idle

- **WHEN** a local-device-backed connection has a trusted idle/drained outbox and `complete` coverage but freshness is `unknown` because no refresh policy declares a staleness window
- **THEN** the verdict SHALL NOT be established and `CollectionSucceeded` SHALL remain unknown
- **AND** the headline state SHALL remain `idle` (neither `healthy` nor `unknown`)

#### Scenario: Local-device verdict never overrides a run outcome

- **WHEN** a connection has a terminal spine run and also satisfies the local-device verdict gates
- **THEN** the projection SHALL derive `CollectionSucceeded` from the run outcome
- **AND** a failed run SHALL NOT be promoted to `healthy` by device evidence

#### Scenario: Degraded or unproven device evidence is never greened by the verdict

- **WHEN** a local-device-backed connection has a stalled outbox, an untrusted/`unknown` outbox, a degrading or `unknown` coverage axis, or no `coverage_diagnostics` at all
- **THEN** the verdict SHALL NOT be established
- **AND** the projection SHALL keep its honest non-`healthy` state (`degraded`, `idle`, or `unknown` as the other axes dictate)
