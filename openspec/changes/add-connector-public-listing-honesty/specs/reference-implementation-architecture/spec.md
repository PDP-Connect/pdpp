# Spec Delta — reference-implementation-architecture

## ADDED Requirements

### Requirement: Reference connector catalog SHALL hide unproven manifests by default

The reference implementation's operator-only `_ref/connectors` catalog SHALL exclude any connector whose manifest is not explicitly opted in as a public listing. This requirement governs reference/operator catalog behavior and is not part of the PDPP protocol contract.

#### Scenario: Manifest is explicitly hidden

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: false`
- **THEN** the reference catalog SHALL NOT include that connector in
  the default `_ref/connectors` response.

#### Scenario: Manifest declares unproven status

- **WHEN** a connector manifest declares
  `capabilities.public_listing.status: "unproven"` without
  `listed: true`
- **THEN** the reference catalog SHALL NOT include that connector in
  the default `_ref/connectors` response.

#### Scenario: Manifest requires a local-device binding without an explicit opt-in

- **WHEN** a connector manifest declares
  `runtime_requirements.bindings.local_device.required: true` and does
  not declare `capabilities.public_listing.listed: true`
- **THEN** the reference catalog SHALL NOT include that connector in
  the default `_ref/connectors` response, because the provider Docker
  deployment cannot satisfy the local-device binding.

#### Scenario: Connector ID matches a known reference stub

- **WHEN** a connector ID contains a known reference test stub
  identifier (such as `manual_action_stub`, `manual-action-stub`, or
  `stream-test-stub`)
- **THEN** the reference catalog SHALL NOT include that connector,
  regardless of manifest contents.

#### Scenario: Manifest is explicitly listed

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: true`
- **THEN** the reference catalog SHALL include that connector in the
  default `_ref/connectors` response, provided the connector ID does
  not match a known reference stub identifier.

### Requirement: First-party manifests SHALL declare public listing status

Every first-party reference manifest distributed under `packages/polyfill-connectors/manifests/` SHALL declare `capabilities.public_listing.listed` as a boolean. Manifests SHALL NOT rely on the implicit default-visible fallback.

#### Scenario: First-party manifest omits public_listing

- **WHEN** a first-party reference manifest does not declare
  `capabilities.public_listing.listed`
- **THEN** the manifest set's honesty test SHALL fail and the manifest
  SHALL NOT be shipped.

#### Scenario: First-party manifest declares listed false

- **WHEN** a first-party reference manifest declares
  `capabilities.public_listing.listed: false`
- **THEN** the manifest SHALL also declare
  `capabilities.public_listing.status: "unproven"` so the reason for
  hiding is recorded alongside the boolean.

### Requirement: Hidden manifests SHALL NOT be background-safe

A connector manifest that is not publicly listed in the reference catalog SHALL NOT declare `capabilities.refresh_policy.background_safe: true`. This interlock keeps the reference scheduler from quietly running a connector that the catalog has marked unproven, local-only, or otherwise not ready.

#### Scenario: Hidden manifest with a background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.listed: false` (or omits `listed: true`
  while declaring `status: "unproven"`)
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Listed manifest with a background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.listed: true`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest is eligible for the reference scheduler under
  the existing scheduler eligibility filter.

### Requirement: Broken-in-current-deployment manifests SHALL NOT auto-schedule

A connector manifest whose `capabilities.public_listing.status` is `"broken_in_current_deployment"` SHALL NOT declare `capabilities.refresh_policy.background_safe: true` and SHALL NOT declare `capabilities.refresh_policy.recommended_mode: "automatic"`. A manifest that the reference deployment already knows is broken at the runtime layer MUST NOT advertise itself as automatically schedulable; the operator surfaces SHALL require manual operator action until the underlying breakage is resolved.

#### Scenario: Broken manifest with background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "broken_in_current_deployment"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Broken manifest with automatic recommended mode

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "broken_in_current_deployment"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.
