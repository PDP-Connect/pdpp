## ADDED Requirements

### Requirement: Run lifecycle SHALL be a closed state set declared exactly once

The reference implementation SHALL define the run lifecycle as a closed set of
states: `pending`, `running`, `awaiting_interaction`, `cancel_requested`,
`succeeded`, `failed`, `surface_failed`, `cancelled`, and `abandoned`. The last
five are terminal.

The state set and its terminal subset SHALL be declared in exactly one place,
and every consumer — projection, fold, query, backfill, and health read — SHALL
derive from that declaration. No component SHALL restate the terminal set as
its own literal collection.

A run state SHALL NOT be represented by a boolean or marker stored beside the
state. Any condition that describes where a run is in its lifecycle SHALL be a
state in this set or SHALL be derived from one.

A dispatch outcome that never started a run SHALL NOT be a run state. The
scheduler MAY record such an attempt for cadence purposes, but the lifecycle
SHALL NOT read it as the outcome of a run.

#### Scenario: The terminal set has one declaration

- **WHEN** any component tests whether a run event is terminal
- **THEN** it SHALL consult the single declared terminal set
- **AND** adding a terminal state SHALL require exactly one edit

#### Scenario: An abandoned run is visible to every terminal reader

- **WHEN** a run reaches `abandoned`
- **THEN** every consumer of the terminal set SHALL observe that run as terminal
- **AND** no consumer SHALL classify it as non-terminal because its own copy of
  the terminal set omits `abandoned`

#### Scenario: Both backends agree on the terminal set

- **WHEN** the same run is read through the SQLite path and the PostgreSQL path
- **THEN** both SHALL report the same terminal classification

### Requirement: Every run-state transition SHALL be an epoch-fenced compare-and-swap

Every durable run-state transition SHALL be expressed as a single conditional
statement predicated on both the expected current state and the acting owner
epoch. A transition SHALL NOT read the current state and then write it in a
separate statement.

A transition whose predicate matches no row SHALL be treated as refused. A
refusal SHALL be an ordinary outcome: it SHALL NOT be retried by re-reading and
re-writing, SHALL NOT raise owner attention, and SHALL NOT be recorded as a
failure of the run.

A run SHALL carry the identity of the owner epoch entitled to transition it,
recorded durably in the same write that admits the run. A process whose epoch
is not the run's owner epoch SHALL fail to transition that run **at the
database**, not by an in-process check.

The predicate SHALL be expressed so that it is identical in effect on SQLite
and PostgreSQL. A null owner epoch SHALL be treated as unclaimed. The null arm
SHALL be spelled out explicitly and SHALL NOT be written in a form that reduces
to excluding null rows on either backend.

Run identity for fencing purposes SHALL be the pair of run identifier and
connector instance identifier, because a run identifier alone is not unique
across connections.

#### Scenario: A stale epoch's write is refused by the database

- **WHEN** a process whose owner epoch is not the run's owner epoch attempts any
  transition on that run
- **THEN** the statement SHALL match no row
- **AND** the run's state SHALL be unchanged

#### Scenario: A transition from an unexpected state is refused

- **WHEN** a transition expects a run to be in one state and the run is in
  another
- **THEN** the statement SHALL match no row
- **AND** the caller SHALL treat the refusal as an ordinary outcome

#### Scenario: A legacy run with no recorded owner epoch is claimable

- **WHEN** a transition targets a run whose owner epoch is null
- **THEN** the transition SHALL be permitted
- **AND** the predicate SHALL NOT spare that run on either backend

#### Scenario: Two connections sharing a run identifier are fenced apart

- **WHEN** two runs on different connector instances share a run identifier
- **THEN** a transition on one SHALL NOT match the other

### Requirement: Exactly one component SHALL write run state

All run-state transitions SHALL pass through a single owner module. No other
component SHALL emit a run lifecycle event, update the durable run projection,
or mutate an in-process structure that other components read as run state.

A shared helper that many components import SHALL NOT satisfy this requirement.
The requirement is one code path that owns the mutations, not one function that
many code paths call.

A component that writes run state SHALL NOT also decide which work runs next.

#### Scenario: A second writer cannot terminalize a run

- **WHEN** a component other than the owner module attempts to record a run's
  terminal state
- **THEN** the attempt SHALL be rejected
- **AND** the run's terminal state SHALL remain whatever the owner module wrote

#### Scenario: A terminal run cannot be revised

- **WHEN** any component attempts a transition on a run already in a terminal
  state
- **THEN** the transition SHALL be refused
- **AND** the run's recorded record count SHALL NOT be revised

### Requirement: The planner SHALL read run state and SHALL NOT write it

The component that decides which connector to run SHALL read the run lifecycle
and emit intents. It SHALL NOT transition run state.

A planner read SHALL NOT produce a durable side effect. An eligibility probe
that reconciles, repairs, or otherwise writes on the read path SHALL count as
writing run state, regardless of the name of the function that performs it.

The lifecycle SHALL NOT encode scheduling policy. Backoff curves, cooldown
windows, fairness rotation, admission budgets, and automation suppression SHALL
remain the planner's. The lifecycle SHALL answer only whether a transition is
legal.

A run being eligible for a transition SHALL NOT mean the run has been chosen to
execute.

#### Scenario: The planner's eligibility probe writes nothing

- **WHEN** the planner evaluates whether a connector instance is due
- **THEN** that evaluation SHALL perform no durable write
- **AND** it SHALL NOT acquire a write lock on the connector instance

#### Scenario: Scheduling policy stays out of the lifecycle

- **WHEN** a backoff, cooldown, or fairness rule changes
- **THEN** the run lifecycle's states and transitions SHALL be unchanged

### Requirement: Illegal transitions SHALL be refused rather than reconciled later

The reference implementation SHALL define which transitions are legal, and
SHALL refuse every transition outside that definition at the point of the
write.

The following SHALL be illegal: a transition attempted by any component other
than the transition's declared writer; a transition whose actor epoch is not
the run's owner epoch; a second terminal transition on a terminal run; any
transition out of a terminal state; and the recording of an interrupted run as
an observed failure.

A run SHALL NOT be able to remain non-terminal indefinitely with no live owner
epoch. A terminal state SHALL always be reachable for such a run, so that a run
whose owner has died cannot permanently block its connector instance.

#### Scenario: An interrupted run is not recorded as a failure

- **WHEN** a run's owner process died without reporting an outcome
- **THEN** the run SHALL transition to `abandoned`
- **AND** no transition to `failed` SHALL be permitted for that reason

#### Scenario: An ownerless run cannot block its connection forever

- **WHEN** a run is non-terminal and no live epoch owns it
- **THEN** a terminal transition SHALL be reachable for that run
- **AND** its connector instance SHALL become able to admit a new run

### Requirement: Successor adjudication SHALL be a lifecycle transition

Marking a predecessor epoch's non-terminal runs as abandoned SHALL be a legal
transition of the run lifecycle, executed by the owner module at boot. It SHALL
NOT be a separate reconciliation path with its own copy of the state
vocabulary.

The transition SHALL preserve the adjudication behavior already established:
it SHALL be idempotent per originating run-start event so repeated passes
produce exactly one terminal event; it SHALL NOT adjudicate any run belonging
to the newest boot epoch; it SHALL decide eligibility by epoch comparison
rather than by an age threshold; and it SHALL NOT revise the record count of a
run that ingested records before being interrupted.

The terminal event and its durable projection SHALL be written in one
transaction, so a run cannot be terminal in the event log while its projection
still claims to be running.

An owner-operated repair tool MAY apply this transition over a historical
backlog with different scoping, but SHALL use the same transition rather than
reimplementing it, and SHALL remain distinguishable in the recorded provenance
of the events it writes.

#### Scenario: Adjudication at boot is the same transition as everywhere else

- **WHEN** the owner module adjudicates a predecessor epoch's non-terminal run
- **THEN** it SHALL apply the same epoch-fenced transition used for every other
  run-state change

#### Scenario: The event and its projection commit together

- **WHEN** adjudication terminalizes a run
- **THEN** the terminal event and the durable projection SHALL commit in one
  transaction
- **AND** no run SHALL be observable as terminal in one and running in the other

#### Scenario: Repeated adjudication is idempotent

- **WHEN** adjudication runs twice over the same interrupted run
- **THEN** exactly one terminal event SHALL exist for that run
