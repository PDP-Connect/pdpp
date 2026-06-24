## ADDED Requirements

### Requirement: Reference Explore record identity SHALL be shared and declaration-led

The reference implementation SHALL render Explore record identity through one shared presentation model across feed row, stream table cell, mobile card, and record detail header surfaces. The shared model SHALL use manifest-authored display roles as the only source of confident primary-title treatment and SHALL NOT synthesize primary-title semantics from field names.

#### Scenario: Declared title renders consistently

**WHEN** a record has manifest-authored display content such as an `x_pdpp_role` primary title
**THEN** the reference Explore feed row, stream table cell, mobile card, and record detail header SHALL render the same primary identity for that record.

#### Scenario: Id-only record key is demoted

**WHEN** a record has no manifest-authored display content and only exposes machine identity values such as an id, uuid, or record key
**THEN** the reference Explore detail header SHALL NOT render that key as a confident bold title
**AND** all Explore record identity surfaces SHALL render the key only as derived, mono, muted, secondary machine content.

#### Scenario: Field names do not create titles

**WHEN** a record lacks manifest-authored display roles but contains fields named `title`, `name`, `merchant`, or similar
**THEN** the reference Explore identity renderer SHALL NOT treat those field names as sufficient evidence for primary-title semantics.
