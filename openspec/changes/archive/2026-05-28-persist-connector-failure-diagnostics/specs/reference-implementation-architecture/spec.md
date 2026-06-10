## ADDED Requirements

### Requirement: Failed connector exits SHALL preserve bounded owner diagnostics

When a connector child process exits before emitting a valid `DONE` message, the reference runtime SHALL persist enough bounded diagnostic evidence for the owner to understand the observed failure class after the process has exited. The terminal run failure data SHALL include a runtime-authored `failure_origin` and `failure_message`. If the connector wrote stderr before exit, the terminal failure data SHALL also include a bounded, redacted stderr diagnostic excerpt with byte-count and truncation metadata.

The persisted stderr diagnostic SHALL be treated as connector-authored, untrusted diagnostic evidence. It SHALL be visible only on owner/control-plane surfaces and SHALL NOT be exposed through grant-scoped `/v1` data, search, schema, or blob APIs.

The runtime SHALL bound stderr capture before persistence; it SHALL NOT accumulate unbounded stderr in memory for the lifetime of a run. The diagnostic excerpt SHALL be redacted before it is written to the run timeline and SHALL preserve metadata that tells the owner whether the excerpt was truncated.

#### Scenario: Connector exits before DONE after writing stderr

- **WHEN** a connector child process writes stderr and exits with a non-zero code before emitting `DONE`
- **THEN** the persisted terminal `run.failed` data SHALL include `failure_origin: "connector"`
- **AND** it SHALL include a runtime-authored `failure_message`
- **AND** it SHALL include the connector `exit_code`
- **AND** it SHALL include a `connector_diagnostics.stderr_tail` object containing a bounded redacted excerpt, `bytes_observed`, `bytes_captured`, `truncated`, and `redacted`.

#### Scenario: Connector stderr exceeds the diagnostic cap

- **WHEN** a connector writes more stderr than the configured diagnostic cap before exiting
- **THEN** the persisted `connector_diagnostics.stderr_tail.text` SHALL contain only a bounded tail excerpt
- **AND** `truncated` SHALL be `true`
- **AND** `bytes_observed` SHALL be greater than `bytes_captured`.

#### Scenario: Connector stderr contains a secret-like value

- **WHEN** captured connector stderr contains a value matching the reference diagnostic redaction policy
- **THEN** the persisted stderr excerpt SHALL contain the redacted replacement rather than the original secret
- **AND** the diagnostic metadata SHALL indicate that redaction was applied.

#### Scenario: Client-token read cannot access connector stderr diagnostics

- **WHEN** a grant-scoped client token reads records, search results, schema, blobs, or other `/v1` resources within its grant
- **THEN** connector stderr diagnostics from run timelines SHALL NOT be included in the response
- **AND** the client SHALL NOT receive a URL or object identifier that grants access to those diagnostics.

#### Scenario: Owner run timeline can inspect connector stderr diagnostics

- **WHEN** the owner reads the failed run timeline through the reference control plane
- **THEN** the terminal failure event SHALL include the bounded connector diagnostic fields
- **AND** the diagnostic SHALL be labeled or shaped so the dashboard can distinguish connector-authored stderr from runtime-authored failure classification.

### Requirement: Node diagnostic reports SHALL be secret-minimized when enabled

When the reference implementation enables Node.js diagnostic reports for a process whose environment may be inherited by connector child processes, it SHALL configure those reports to exclude environment variables and network details. Diagnostic reports are reference/operator artifacts for crash investigation; they SHALL NOT become grant-scoped PDPP data, and the reference SHALL NOT expose report paths or report contents through `/v1` client APIs.

#### Scenario: Dev command enables connector-inheritable Node reports

- **WHEN** a reference dev command enables `--report-on-fatalerror` or `--report-uncaught-exception`
- **AND** connector child processes may inherit those report settings through `NODE_OPTIONS` or process environment
- **THEN** the command SHALL also enable `--report-exclude-env`
- **AND** it SHALL enable `--report-exclude-network`.

#### Scenario: A connector child produces a Node diagnostic report

- **WHEN** a connector child process produces a Node diagnostic report
- **THEN** the report SHALL be treated as an operator-local diagnostic artifact
- **AND** client-token `/v1` reads SHALL NOT expose the report content, path, or object identifier.
