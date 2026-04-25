## ADDED Requirements

### Requirement: Partial connector runs SHALL expose known gaps
The reference runtime SHALL expose machine-readable known gaps when a connector run skips streams, records, or source regions that were in requested scope but not collected.

#### Scenario: A stream is skipped because credentials are missing
- **WHEN** a connector cannot collect a requested stream because required credentials or interaction are absent
- **THEN** the run timeline SHALL record the skipped stream and reason
- **AND** the operator surface SHALL distinguish that gap from a successful complete collection

### Requirement: Partial data SHALL NOT be represented as complete
The reference implementation SHALL NOT present records from an incomplete connector run as evidence that the requested scope was fully collected unless the run has no known gaps for that scope.

#### Scenario: A connector flushes records before a later stream fails
- **WHEN** a run flushes records for one stream and then fails or skips another requested stream
- **THEN** the flushed records MAY remain queryable
- **AND** reference diagnostics SHALL preserve that the latest run had known gaps

### Requirement: Recovery hints SHALL be bounded and non-secret
Known-gap and skip diagnostics SHALL include bounded recovery hints when the runtime or connector can identify a next step, but SHALL NOT persist credentials, OTPs, cookies, raw page contents, or other secrets.

#### Scenario: A manual login is required
- **WHEN** a connector requires a manual login or anti-bot resolution before it can continue
- **THEN** the run timeline MAY expose a recovery hint such as `manual_action_required`
- **AND** it SHALL NOT persist submitted credentials or browser session secrets
