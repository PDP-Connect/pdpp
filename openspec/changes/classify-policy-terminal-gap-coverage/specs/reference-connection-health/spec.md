## MODIFIED Requirements

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog,
dead letters, retryable detail gaps, terminal detail-gap evidence, and owner
attention as separate condition families. A terminal detail gap with an
explicit policy disposition SHALL remain visible in diagnostics and terminal
totals, but SHALL NOT by itself produce a repair-blocking `terminal_gap` or a
maintainer `code_fix` action. A terminal detail gap without that policy
disposition SHALL remain repair-blocking.

#### Scenario: Policy terminal evidence stays visible without a false code fix

- **WHEN** a connection has a terminal detail gap with policy reason
  `too_large`
- **THEN** the terminal row and its aggregate count SHALL remain visible
- **AND** that row alone SHALL NOT produce a `terminal_gap` coverage condition
  or maintainer `code_fix` action.

#### Scenario: Non-policy terminal evidence remains repair-blocking

- **WHEN** a connection has a terminal detail gap with a non-policy reason
- **THEN** the affected stream SHALL remain `terminal_gap`
- **AND** the projection SHALL retain the maintainer repair action.
