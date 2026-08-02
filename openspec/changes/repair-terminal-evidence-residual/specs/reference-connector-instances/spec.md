## ADDED Requirements

### Requirement: Summary-evidence maintenance SHALL have one explicit startup first-pass authority

The reference implementation SHALL launch its bounded connector-summary
startup walker before it arms periodic maintenance. The startup walker SHALL
use the same durable cursor and fencing as periodic maintenance, SHALL retain
its finite round cap, and SHALL not be suppressed by a competing immediate
timer tick. Owner read routes SHALL remain read-only.

#### Scenario: A restart finds dirty evidence with current canonical facts

- **WHEN** the reference starts with a connection whose summary evidence is dirty
- **THEN** the startup walker SHALL attempt a bounded repair without waiting
  for the first periodic interval
- **AND** a failed repair SHALL leave the evidence visibly non-current for a later maintenance retry
- **AND** an owner read SHALL NOT perform that repair itself.

#### Scenario: The startup walker and periodic timer overlap at boot

- **WHEN** a periodic timer attempts an immediate tick while the startup
  walker owns its first fenced evidence round
- **THEN** the startup walker SHALL complete at least that first round
- **AND** the periodic attempt SHALL NOT start a second evidence writer
- **AND** later timer ticks SHALL retain their normal periodic cadence.
