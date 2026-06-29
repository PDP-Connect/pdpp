## MODIFIED Requirements

### Requirement: Owner source surfaces SHALL degrade transient read failures without premature alarm

When the owner console cannot refresh the source list because a read fails, the source surface SHALL distinguish a transient first failure from a persistent failure.

#### Scenario: First read failure during refresh

- **WHEN** a Sources route refresh fails during a dynamic read
- **AND** the console has not yet attempted its automatic recovery
- **THEN** it SHALL render quiet retrying copy
- **AND** it SHALL NOT render the explicit failure headline yet

#### Scenario: Automatic recovery also fails

- **WHEN** a Sources route refresh fails
- **AND** the automatic recovery has already been attempted
- **THEN** it SHALL render explicit read-failure copy
- **AND** it SHALL offer a manual retry control

#### Scenario: Last successful load timestamp

- **WHEN** the read-failure boundary has a client-cached timestamp for the last clean render
- **THEN** it MAY display that timestamp as the last successful load
- **AND** it SHALL NOT claim to render cached source rows unless such rows are actually rendered
