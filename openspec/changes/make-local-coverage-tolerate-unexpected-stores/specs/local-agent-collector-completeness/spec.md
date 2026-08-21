## MODIFIED Requirements

### Requirement: Coverage snapshots SHALL tolerate unexpected stores and refuse missing ones

A local coverage snapshot SHALL commit when every store the server declares is
accounted for, even if the collector also reports stores the server does not
declare. A store the server does not declare SHALL NOT contribute to the proof and
SHALL NOT disqualify it. A snapshot SHALL NOT commit when a declared store is
missing, when a store is reported more than once, or when an entry is malformed.

#### Scenario: Older collector reports a store the server no longer declares

- **WHEN** a coverage snapshot contains every declared store and one additional
  store the server does not declare
- **THEN** the snapshot SHALL commit
- **AND** the undeclared store SHALL be reported as unexpected
- **AND** the undeclared store SHALL NOT appear in the accounted rows

#### Scenario: A declared store is absent

- **WHEN** a coverage snapshot omits a store the server declares
- **THEN** the snapshot SHALL NOT commit
- **AND** the absent store SHALL be reported as missing

#### Scenario: A store is reported twice

- **WHEN** a coverage snapshot reports the same store more than once
- **THEN** the snapshot SHALL NOT commit

#### Scenario: An entry is malformed

- **WHEN** a coverage snapshot contains an entry that cannot be parsed
- **THEN** the snapshot SHALL NOT commit
