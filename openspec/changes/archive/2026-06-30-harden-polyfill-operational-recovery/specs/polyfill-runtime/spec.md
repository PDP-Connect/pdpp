## ADDED Requirements

### Requirement: Browser-backed connector failures SHALL preserve source-state meaning

Browser-backed connectors SHALL distinguish known source-unavailable page states from connector selector-shape failures when retained fixture or page text makes the distinction available.

#### Scenario: Source reports login unavailable

- **WHEN** a browser-backed connector reaches a login step
- **AND** the source page reports that its system or request handling is currently unavailable
- **THEN** the connector SHALL report a source-unavailable failure class
- **AND** it SHALL NOT report the same event as a missing-field selector failure

#### Scenario: Login field is missing without source-unavailable evidence

- **WHEN** a browser-backed connector expects the next login field
- **AND** the field does not appear
- **AND** the page does not contain known source-unavailable evidence
- **THEN** the connector MAY report a selector-shape or field-missing diagnostic

### Requirement: Patchright browser install SHALL fail only when browser proof is required

The polyfill connector package postinstall SHALL skip optional Patchright Chromium download on hosts where Patchright does not publish the requested browser, unless strict browser-download proof is explicitly required by environment.

#### Scenario: Unsupported local Patchright browser platform

- **WHEN** package installation runs on a host where Patchright does not publish the requested Chromium build
- **AND** strict browser-download proof is not requested
- **THEN** postinstall SHALL exit successfully after explaining that the optional browser download was skipped

#### Scenario: Strict browser-download proof requested

- **WHEN** package installation runs on a host where Patchright does not publish the requested Chromium build
- **AND** strict browser-download proof is requested
- **THEN** postinstall SHALL fail
