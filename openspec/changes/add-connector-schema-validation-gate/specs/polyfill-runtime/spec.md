## ADDED Requirements

### Requirement: Connectors declaring manifest streams SHALL validate emitted records or be on a justified schemaless allowlist

A first-party polyfill connector whose manifest declares one or more streams SHALL wire emit-time record validation into its runtime entrypoint (`runConnector({ ..., validateRecord })`, conventionally built with `makeValidateRecord` over a `schemas.ts` registry), OR SHALL appear on an explicit schemaless allowlist with a per-connector justification.

This requirement is reference-implementation authoring policy and CI tooling. It
SHALL NOT be treated as PDPP Core protocol semantics or as a Collection Profile
runtime requirement: the runtime entrypoint's `validateRecord` parameter remains
optional so the framework can still execute a zero-dependency connector. The
requirement constrains how first-party connectors are authored and how the
reference build verifies them, not what a conformant resource server or
Collection Profile implementation must do.

A build-time check SHALL enforce this invariant in the path CI already runs, and
SHALL fail with the offending connector name when the invariant is violated.

#### Scenario: A connector declares manifest streams and wires validation

- **WHEN** a connector's manifest declares one or more streams
- **AND** the connector wires `validateRecord` into its `runConnector` entrypoint
- **THEN** the build-time check SHALL pass for that connector
- **AND** the connector SHALL NOT appear on the schemaless allowlist.

#### Scenario: A new connector declares streams but omits validation

- **WHEN** a connector's manifest declares one or more streams
- **AND** the connector does not wire `validateRecord`
- **AND** the connector is not on the schemaless allowlist
- **THEN** the build-time check SHALL fail and name that connector
- **AND** the failure message SHALL direct the author to either wire validation
  or add a justified allowlist entry.

#### Scenario: An allowlisted connector adds validation later

- **WHEN** a connector that is on the schemaless allowlist begins wiring
  `validateRecord`
- **THEN** the build-time check SHALL fail until the connector's allowlist entry
  is removed
- **AND** the allowlist SHALL therefore only ever shrink as connectors adopt
  validation.

#### Scenario: A connector declares no streams

- **WHEN** a connector's manifest declares zero streams
- **THEN** the build-time check SHALL NOT require validation wiring for that
  connector
- **AND** the connector SHALL NOT be required to appear on the allowlist.

#### Scenario: The schemaless allowlist carries justifications

- **WHEN** a connector is on the schemaless allowlist
- **THEN** its entry SHALL carry an owner-readable justification identifying why
  validation is not yet wired and the remediation path
- **AND** the allowlist SHALL be the authoritative, machine-checked census of
  connectors that emit records without emit-time shape validation.
