## ADDED Requirements

### Requirement: Browser-backed polyfill connectors SHALL declare a browser runtime binding

The reference implementation SHALL make browser automation requirements visible in polyfill connector manifests using `runtime_requirements.bindings.browser`.

#### Scenario: Browser-backed connector manifest is inspected

- **WHEN** a polyfill connector uses the reference browser runtime
- **THEN** its manifest SHALL declare `runtime_requirements.bindings.browser.required` equal to `true`
- **AND** the manifest SHALL NOT rely on `network` alone to imply browser automation.

#### Scenario: Reference runtime starts a connector

- **WHEN** the reference runtime sends a `START` envelope to a connector
- **THEN** the available bindings SHALL include `browser`
- **AND** a manifest requiring the `browser` binding SHALL pass binding matching when the runtime can supply browser automation.

#### Scenario: Runtime requirement binding declaration is malformed

- **WHEN** a connector manifest declares an unsupported runtime binding or a non-boolean `required` value
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the malformed runtime requirement.
