## ADDED Requirements

### Requirement: Stream parity oracle SHALL require explicit behavior passes

The reference implementation's stream parity command SHALL pass only when every bound phone-surface, restoration, and keyboard behavior contract passes. It SHALL NOT treat a pending integration, an oracle-binding requirement, a source marker, or a direct target-page visit as a passing result.

#### Scenario: A required behavior contract is not proven

- **WHEN** any required phone-surface, restoration, or keyboard behavior test fails
- **THEN** `pnpm stream:parity:oracle` SHALL fail

### Requirement: Phone-surface verification SHALL traverse the stream route

The parity oracle SHALL verify the phone surface through the controlling run-interaction stream attachment. It SHALL assert viewport-driven `412x915` and `915x412` screen selections, window-size acknowledgements, and restoration of the terminal desktop baseline.

#### Scenario: Owner rotates an attached phone presentation

- **WHEN** the controlling attachment posts portrait and rotated landscape viewports
- **THEN** the n.eko boundary SHALL receive both selected screen configurations and both window-size acknowledgements
- **AND** terminal resolution SHALL restore the desktop baseline

### Requirement: External calibration SHALL remain informational

An external remote-surface deployment MAY be probed for calibration, but its reachability SHALL NOT determine the local parity command's result.

#### Scenario: External calibration is unavailable

- **WHEN** the calibration endpoint cannot be reached
- **THEN** the calibration command SHALL report the endpoint as unavailable
- **AND** it SHALL not represent that result as a local verification failure
