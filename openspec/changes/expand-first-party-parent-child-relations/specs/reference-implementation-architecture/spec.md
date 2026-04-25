## ADDED Requirements

### Requirement: First-party expansion declarations are conservative and grant-safe

First-party connector manifests SHALL enable `query.expand` only for relations that the current reference engine can serve as one-hop parent-to-child expansions with child grant projection.

#### Scenario: A safe child collection is expanded

- **WHEN** a first-party stream declares `query.expand` for a has-many child collection
- **AND** the child stream has a top-level foreign key referencing the parent record key
- **AND** the caller's grant includes both parent and child streams
- **THEN** record list and detail responses MAY include the child records under `expanded.<relation>`
- **AND** the child records SHALL be projected according to the child stream grant.

#### Scenario: A child stream is not granted

- **WHEN** a caller requests an enabled expansion but the grant does not include the related child stream
- **THEN** the reference SHALL reject the request with insufficient scope rather than silently omitting or partially hydrating the relation.

#### Scenario: A tempting reverse relation is present

- **WHEN** a relation requires looking up a parent or sibling from a foreign key on the current record
- **THEN** first-party manifests SHALL NOT enable it through `query.expand` until a reverse/belongs-to relation contract is specified and tested.
