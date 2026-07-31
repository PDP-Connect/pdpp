## ADDED Requirements

### Requirement: Terminal owner connector LIST projection evidence

The reference implementation SHALL retain a complete owner connector LIST item
in the existing per-connection summary-evidence row only when its canonical
record, terminal-fact, and manifest components are current. The payload SHALL
carry only a connection-scoped, already-observed runtime projection; a LIST
reader SHALL NOT discover runtime state or history to fill it.

#### Scenario: Canonical mutation invalidates published list evidence

**WHEN** a canonical connection mutation marks summary evidence dirty or a
canonical rebuild replaces its evidence
**THEN** the terminal list projection becomes stale and SHALL NOT be returned
as current projection truth.

#### Scenario: Late snapshot publication is rejected

**WHEN** a publisher captures canonical evidence snapshot A, canonical evidence
then rebuilds or becomes dirty as B, and the publisher attempts to publish the
A-derived payload
**THEN** publication SHALL affect no row and the terminal reader SHALL NOT
expose A as current projection truth.

#### Scenario: Read observes without repair

**WHEN** an owner LIST projection reader reads a terminal evidence row
**THEN** it SHALL return the stored current payload or its explicit non-current
state without writing, rebuilding, reconciling, or observing runtime state.
