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
  `capabilities.public_listing.status` as either `"unproven"` (the
  default reason for hiding a not-yet-exercised manifest) or
  `"deprecated_upstream"` (the reason for hiding a manifest whose
  upstream API has been shut down). Both values are absolute
  hidden-by-design reasons; no other status value paired with
  `listed: false` is permitted.

### Requirement: Reference connector catalog SHALL be complete for listed first-party manifests

After the reference implementation's startup `reconcilePolyfillManifests` pass, every first-party manifest under `packages/polyfill-connectors/manifests/` that declares `capabilities.public_listing.listed: true` SHALL be present in the connectors table and SHALL appear in `GET /_ref/connectors`, regardless of whether the operator has ever scheduled or run the connector. Registration through this path is the catalog visibility act; it is NOT schedule enablement. Hidden / unproven first-party manifests, manifests outside the shipped first-party set (custom user-authored connectors), and known stub connector IDs SHALL NOT be auto-registered by this path.

#### Scenario: Listed first-party manifest with no prior schedule or run

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: true`
- **AND** the connectors table contains no row for that manifest's
  `connector_id` (no schedule, no prior run)
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL register the manifest so the
  operator catalog includes it.

#### Scenario: Hidden first-party manifest with no prior schedule or run

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: false` (or omits a
  `listed: true` declaration)
- **AND** the connectors table contains no row for that manifest's
  `connector_id`
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL NOT register the manifest,
  preserving the hidden-from-catalog state for unproven and
  deprecated-upstream manifests.

#### Scenario: Custom user-authored manifest with no prior schedule or run

- **WHEN** a manifest declaring `capabilities.public_listing.listed: true`
  is registered by means other than the shipped first-party manifests
  directory (e.g. a user-authored custom connector)
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL NOT alter that registration,
  because it operates only on files under the shipped first-party
  manifests directory.

#### Scenario: Registration is not schedule enablement

- **WHEN** `reconcilePolyfillManifests` auto-registers a listed
  first-party manifest on startup
- **THEN** the scheduler eligibility filter
  (`refresh_policy.background_safe`) and the operator-driven schedule
  creation path SHALL continue to gate background runs independently,
  so the auto-registration alone SHALL NOT cause the connector to run
  on a schedule.

### Requirement: Deprecated-upstream manifests SHALL be hidden and manual

A connector manifest whose `capabilities.public_listing.status` is `"deprecated_upstream"` SHALL declare `capabilities.public_listing.listed: false` and SHALL NOT declare `capabilities.refresh_policy.background_safe: true` or `capabilities.refresh_policy.recommended_mode: "automatic"`. A connector whose upstream API has been shut down cannot run, so honesty requires both the catalog hide (so operators do not see a dead connector advertised as ready) and the schedule-eligibility hide (so the reference scheduler does not queue runs against an API that no longer exists).

#### Scenario: Deprecated-upstream manifest declares listed=true

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.public_listing.listed: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Deprecated-upstream manifest with background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Deprecated-upstream manifest with automatic recommended mode

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

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

### Requirement: Needs-human-auth manifests SHALL NOT auto-schedule

A connector manifest whose `capabilities.public_listing.status` is `"needs_human_auth"` SHALL NOT declare `capabilities.refresh_policy.background_safe: true` and SHALL NOT declare `capabilities.refresh_policy.recommended_mode: "automatic"`. A manifest that requires human-supplied credentials, OTP confirmation, or a manual browser action cannot honestly run unattended. The reference today models no durable no-human unattended auth capability, so until such a capability is explicitly modeled, `needs_human_auth` is incompatible with automatic background refresh.

#### Scenario: Needs-human-auth manifest with background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Needs-human-auth manifest with automatic recommended mode

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.
