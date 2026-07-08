## ADDED Requirements

### Requirement: Playground form overlay mode drives text through native local controls

The remote-surface playground SHALL provide a toggleable form-overlay mode that detects remote editable fields, renders local native controls over the stream, and commits text edits through the package form-overlay commit planner.

#### Scenario: Overlay mode is disabled

- **WHEN** the playground form-overlay toggle is off
- **THEN** the playground SHALL preserve the existing direct keyboard/text input path
- **AND** the input-path telemetry SHALL identify the adapter path used by the direct commit

#### Scenario: Overlay mode is enabled

- **WHEN** the playground form-overlay toggle is on and the probe page exposes editable fields
- **THEN** the playground SHALL render local native input or textarea controls aligned to the remote field rectangles
- **AND** user text edits SHALL be converted to form-overlay commit operations before reaching the remote browser

#### Scenario: Overlay commit telemetry is visible

- **WHEN** overlay mode commits one or more characters to the remote browser
- **THEN** the playground SHALL show `overlay-commit` for every overlay-committed character in the input-path telemetry panel

#### Scenario: Overlay acceptance covers the login-style journey

- **WHEN** the playground acceptance test runs in overlay mode
- **THEN** email, password, one-time-code, backspace, replacement, paste, and submit checks SHALL complete against the probe page
