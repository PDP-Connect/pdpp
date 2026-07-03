## MODIFIED Requirements

### Requirement: Polyfill connector manifests SHALL expose external subprocess tool dependencies

The reference implementation SHALL support static manifest metadata for external subprocess tools required by polyfill connectors. Runtime detection for those tools SHALL be structured as an executable plus explicit arguments and SHALL NOT be executed through a shell.

#### Scenario: Connector manifest declares an external subprocess tool

- **WHEN** a polyfill connector depends on an external subprocess binary
- **THEN** its manifest SHALL declare the dependency under `runtime_requirements.external_tools`
- **AND** each declaration SHALL include `name`, `license`, and `purpose`.

#### Scenario: Slack connector manifest is inspected

- **WHEN** the Slack connector manifest is inspected
- **THEN** it SHALL declare `slackdump` as an external tool
- **AND** the declaration SHALL include its license and an owner-usable install hint
- **AND** the declaration MAY include structured detection metadata.

#### Scenario: Connector manifest declares structured detection metadata

- **WHEN** a connector manifest declares `runtime_requirements.external_tools[].detect`
- **THEN** the detection metadata MAY include `executable`, `args`, and `exit_code`
- **AND** `executable` SHALL be a non-empty string
- **AND** `args`, when present, SHALL be an array of strings
- **AND** the runtime SHALL execute the detector using array-form process spawning with no shell.

#### Scenario: Connector manifest declares a legacy shell command detector

- **WHEN** a connector manifest declares `runtime_requirements.external_tools[].detect.command`
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the unsupported detector field
- **AND** the runtime SHALL NOT execute the value.

#### Scenario: External tool declaration is malformed

- **WHEN** a connector manifest declares malformed `runtime_requirements.external_tools`
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the malformed external tool declaration.
