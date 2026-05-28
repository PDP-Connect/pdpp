## ADDED Requirements

### Requirement: Disclosure Spine Timeline Pagination

The reference implementation SHALL paginate disclosure-spine timelines with a stable logical event ordering. Cursor tokens SHALL NOT depend on SQLite `rowid` or another backend-private physical row identity.

#### Scenario: Tied timestamps remain stable

**WHEN** multiple disclosure-spine events in the same timeline have identical `occurred_at` timestamps
**THEN** paginated reads SHALL return each event exactly once in stable append order
**AND** a cursor returned by one page SHALL resume after the last event served by that page.

#### Scenario: Cursor remains backend-portable

**WHEN** the reference implementation encodes a disclosure-spine timeline cursor
**THEN** the cursor SHALL be opaque to clients
**AND** the decoded cursor state SHALL refer only to stable logical ordering fields, not SQLite physical row identity.
