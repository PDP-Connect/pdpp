## ADDED Requirements

### Requirement: Add data SHALL be a compact decision surface

The reference owner console Add data surface SHALL present available source setup choices as a compact decision surface by default. Each available source row SHALL carry one source identity, one concise method or material line, one current support fact, and at most one real primary next action. Detailed setup rationale, acquisition instructions, existing-source reuse controls, and external source instructions SHALL NOT be expanded inline for every default row.

#### Scenario: The owner scans add-now choices

- **WHEN** the owner opens `/dashboard/records/add` with no search query
- **THEN** the primary available-source group SHALL render comparable source choices
- **AND** it SHALL NOT repeat generic rationale disclosure copy for every row
- **AND** artifact-import sources SHALL NOT expand their acquisition instructions or existing-source management controls inline before the owner chooses that source

#### Scenario: A source requires server setup

- **WHEN** a source requires server or operator configuration before owner account setup can begin
- **THEN** the Add data surface SHALL summarize that prerequisite outside the primary add-now group
- **AND** it SHALL NOT render the source as another default add-now card

#### Scenario: A source cannot be added from this page

- **WHEN** a source has no shipped owner-usable add path in the current reference deployment
- **THEN** the Add data surface SHALL keep it hidden from the default add-now list or behind a collapsed/search-specific unavailable section
- **AND** it SHALL NOT render a primary setup action for that source
