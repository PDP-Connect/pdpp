## ADDED Requirements

### Requirement: The runtime SHALL lease-settle explicit terminal detail gaps

The reference runtime SHALL accept a terminal detail-gap outcome only when it
names the current served gap and matching lease. It SHALL flush the accepted
connector record before a lease-owned compare-and-set transition to
`terminal`, preserve the exact bounded `last_error`, `gap_id`, `lease_id`,
locator, and `reason`, clear the pending lease, and emit terminal evidence;
the connector SHALL emit its accumulated optional-skip coverage before `DONE`.
The transition SHALL NOT increment provider attempt accounting. A missing,
stale, or mismatched lease SHALL fail closed without settling another row.

#### Scenario: A terminal Gmail policy outcome is not a false recovery

- **WHEN** a served Gmail outcome has `status: "terminal"`,
  `retryable: false`, and reason/class `too_large`
- **THEN** the durable gap SHALL be terminal and no recovered event SHALL be
  emitted
- **AND** coverage evidence SHALL still account for the optional skip.

### Requirement: Owner repair SHALL be bounded and exact-scope

The reference implementation SHALL provide an owner/operator repair command
for existing pending Gmail attachment gaps whose exact stored error class is
`too_large`. The command SHALL require the Gmail connector, an exact connector
instance, the `attachments` stream, and the `too_large` class; SHALL cap the
scope; SHALL default to dry-run; SHALL emit a bounded receipt; SHALL be
idempotent; and SHALL use the canonical detail-gap store primitives. It SHALL
not mutate retryable rows or use a parallel gap store/direct SQL one-off.

#### Scenario: Dry-run and apply fail closed

- **WHEN** an operator invokes the command without explicit apply
- **THEN** it SHALL report matching rows without mutation
- **AND** explicit apply SHALL terminalize only exact pending `too_large`
  rows in the requested scope
- **AND** retryable rows, wrong scopes, and already-terminal rows SHALL remain
  unchanged
- **AND** repeating apply SHALL make no further mutation.
