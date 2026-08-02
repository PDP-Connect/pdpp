## ADDED Requirements

### Requirement: Summary-evidence maintenance SHALL begin without a periodic-delay gap

The reference implementation SHALL run one bounded connector-summary
maintenance pass when its maintenance timer is armed. The pass SHALL use the
same durable cursor and fencing as periodic maintenance. Owner read routes
SHALL remain read-only.

#### Scenario: A restart finds dirty evidence with current canonical facts

- **WHEN** the reference starts with a connection whose summary evidence is dirty
- **THEN** maintenance SHALL attempt a bounded repair without waiting for the first periodic interval
- **AND** a failed repair SHALL leave the evidence visibly non-current for a later maintenance retry
- **AND** an owner read SHALL NOT perform that repair itself.
