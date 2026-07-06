## ADDED Requirements

### Requirement: Runtime fixture capture SHALL use a deploy-stable root

When fixture capture is enabled, the polyfill runtime SHALL write raw diagnostic captures under a configurable capture root. If the capture root is not configured, local development MAY default to the package fixture directory.

Reference Docker deployments SHALL configure the capture root to persistent runtime storage rather than a bind mount from the deploy checkout.

#### Scenario: Local development uses the package fixture directory

**WHEN** fixture capture is enabled without `PDPP_CAPTURE_ROOT_DIR`
**THEN** the runtime SHALL write captures under the package fixture directory.

#### Scenario: Deployment configures a persistent capture root

**WHEN** the composed reference stack starts the reference service
**THEN** the service SHALL receive a `PDPP_CAPTURE_ROOT_DIR` value inside persistent runtime storage
**AND** the service SHALL NOT depend on a deploy-checkout bind mount for raw capture writes.

#### Scenario: Capture storage is unavailable

**WHEN** fixture capture is enabled but the configured capture root cannot be created
**THEN** capture initialization SHALL fail closed for capture only
**AND** the connector run SHALL proceed without capture rather than failing because diagnostic storage is unavailable.
