## MODIFIED Requirements

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog,
dead letters, retryable detail gaps, terminal detail-gap evidence, and owner
attention as separate condition families. A terminal detail gap with an
explicit policy disposition SHALL remain visible in diagnostics and terminal
totals, but SHALL NOT by itself produce a repair-blocking `terminal_gap` or a
maintainer `code_fix` action. A terminal detail gap without that policy
disposition SHALL remain repair-blocking.

#### Scenario: Proven policy terminal evidence stays visible without a false code fix

- **WHEN** a Gmail attachment terminal settlement writes the validated
  `gmail_attachment_too_large` disposition with observed-size and configured-
  limit evidence
- **THEN** the terminal row and its aggregate count SHALL remain visible
- **AND** that row alone SHALL NOT produce a `terminal_gap` coverage condition
  or maintainer `code_fix` action.

#### Scenario: Mutable terminal fields cannot fabricate policy evidence

- **WHEN** a generic status transition changes a `not_found` terminal row's
  reason or error class to `too_large`
- **THEN** the affected stream SHALL remain `terminal_gap`
- **AND** the projection SHALL retain the maintainer repair action.

#### Scenario: Historical rows without the disposition remain repair-blocking

- **WHEN** a terminal row has no validated policy disposition
- **THEN** its terminal evidence SHALL remain visible and repair-blocking
- **AND** the implementation SHALL NOT infer policy evidence from free text,
  reason, or error class.
