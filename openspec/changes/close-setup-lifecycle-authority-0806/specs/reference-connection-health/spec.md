## ADDED Requirements

### Requirement: Setup terminal disposition SHALL be connection-scoped and evidence-backed

The owner-facing setup projection SHALL reuse the connection's durable
`run_history` row and canonical `collection_facts` evidence. It SHALL expose
distinct terminal dispositions for a verified empty result, an unverified zero,
and missing yield counts. It SHALL NOT infer a verified empty result from an
aggregate count alone.

#### Scenario: Valid empty is proven

- **WHEN** terminal success has facts for every required/in-scope stream
- **AND** each fact has trusted `considered: 0`, no skip or unresolved detail
  gap, and a `committed` or `disabled` checkpoint
- **THEN** setup status SHALL report `verified_empty`

#### Scenario: Silent zero is not proven empty

- **WHEN** terminal success reports an observed aggregate zero
- **AND** canonical collection facts are absent or incomplete
- **THEN** setup status SHALL report `unverified_zero`, not a verified empty

#### Scenario: Missing counts stay missing

- **WHEN** terminal success has no observed yield count and no valid-empty facts
- **THEN** setup status SHALL report `unverified_missing_counts`
- **AND** it SHALL remain terminal attention rather than pending forever

#### Scenario: Owner surfaces share the draft disposition

- **WHEN** a draft has a terminal setup disposition
- **THEN** Dashboard, Sources, and Syncs SHALL consume the same connection-scoped
  disposition and owner action copy
- **AND** the draft SHALL remain inactive and unscheduled
