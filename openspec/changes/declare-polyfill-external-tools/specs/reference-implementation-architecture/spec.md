## ADDED Requirements

### Requirement: Polyfill connector manifests SHALL expose external subprocess tool dependencies

The reference implementation SHALL support static manifest metadata for external subprocess tools required by polyfill connectors.

#### Scenario: Connector manifest declares an external subprocess tool

- **WHEN** a polyfill connector depends on an external subprocess binary
- **THEN** its manifest SHALL declare the dependency under `runtime_requirements.external_tools`
- **AND** each declaration SHALL include `name`, `license`, and `purpose`.

#### Scenario: Slack connector manifest is inspected

- **WHEN** the Slack connector manifest is inspected
- **THEN** it SHALL declare `slackdump` as an external tool
- **AND** the declaration SHALL include its license and an owner-usable install hint.
- **AND** the declaration MAY include non-executed detection metadata.

#### Scenario: External tool declaration is malformed

- **WHEN** a connector manifest declares malformed `runtime_requirements.external_tools`
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the malformed external tool declaration.
