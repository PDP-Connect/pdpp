## ADDED Requirements

### Requirement: Connector runtime startup SHALL fail closed when `START` is missing

The polyfill connector runtime SHALL treat stdin closing, ending, or erroring
before the first `START` line as a terminal startup failure. It SHALL NOT wait
forever, burn CPU, or leave the connector child alive without protocol output.
The failure SHALL flow through the same bounded failed `DONE` path used for other
connector-runtime startup failures.

#### Scenario: Stdin closes before START

- **WHEN** a connector process starts and stdin closes before any `START` line is
  received
- **THEN** the connector SHALL emit a failed `DONE` envelope when stdout is
  available
- **AND** the process SHALL exit non-zero without waiting indefinitely

#### Scenario: Stdin errors before START

- **WHEN** a connector process starts and stdin errors before any `START` line is
  received
- **THEN** the connector SHALL fail the run through the bounded failed `DONE`
  path
- **AND** it SHALL remove startup listeners after the failure settles
