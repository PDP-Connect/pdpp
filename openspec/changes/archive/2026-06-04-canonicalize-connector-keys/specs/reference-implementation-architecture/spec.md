## ADDED Requirements

### Requirement: Reference storage and runtime SHALL use canonical connector keys

The reference implementation SHALL use canonical `connector_key` values for connector-backed storage bindings, source bindings, runtime configuration, state namespaces, record namespaces, blob bindings, schedules, runs, diagnostics, search indexes, semantic indexes, and owner-facing read URLs. URL-shaped manifest identifiers SHALL be metadata only.

#### Scenario: New connector state is written

- **WHEN** a connector run, local collector upload, scheduler operation, grant issuance, search index update, or event-subscription write persists connector-backed state
- **THEN** the persisted connector type field SHALL contain the canonical `connector_key`
- **AND** it SHALL NOT contain the manifest registry URI.

#### Scenario: Owner search returns record URLs

- **WHEN** an owner or grant-scoped client receives a record URL or hydration hint from search, Explore, MCP, or a dashboard API
- **THEN** the URL or hint SHALL carry the canonical connector key and the concrete `connection_id` when needed
- **AND** it SHALL NOT rely on URL-shaped connector ids to hydrate the record.

#### Scenario: Local-device exporter persists records and state

- **WHEN** a local-device exporter enrolls, ingests record batches, or writes device-scoped sync state for a connector type whose owner-supplied id is a legacy alias such as `claude_code`
- **THEN** the catalog `connectors` row, the `connector_instances` row, the `device_source_instances` row, and the persisted record/state/version/blob rows SHALL all use the bare canonical `connector_key` (e.g. `claude-code`)
- **AND** the persisted connector type field SHALL NOT carry a `local-device:` storage-namespace prefix
- **AND** isolation between a local-device connection and an account connection for the same connector type SHALL be carried by `connector_instance_id`, not by a storage-key prefix.

#### Scenario: Grant-scoped or owner read resolves a connection from a legacy storage binding

- **WHEN** a grant-scoped client read, owner self-export read, or blob fetch resolves the active connection set from a storage binding whose `connector_id` still carries a legacy URL-shaped first-party id (e.g. `https://registry.pdpp.org/connectors/gmail`)
- **THEN** the admission resolver SHALL canonicalize that `connector_id` to its `connector_key` (e.g. `gmail`) before enumerating active `connector_instances`
- **AND** it SHALL resolve the same connection set it would for the bare canonical key, because records, blob bindings, and `connector_instances` are all keyed by `connector_key`
- **AND** it SHALL NOT return `connection_not_found` solely because the storage binding carried the legacy URL alias rather than the canonical key.

### Requirement: Reference forms SHALL NOT delimiter-parse connector identifiers

Reference forms and route handlers SHALL use structured, validated, or opaque identifiers for connector and connection selections. They SHALL NOT parse concatenated raw connector identifiers with delimiters that may appear inside registry URLs or future custom ids.

#### Scenario: Hosted MCP package selector submits a connection

- **WHEN** the hosted MCP package consent form submits an approved connection selection
- **THEN** the server SHALL resolve that selection from an opaque connection id or a structured payload
- **AND** it SHALL NOT split a raw `connector_id` string such as `connection:<connector_id>:<connection_id>`.

#### Scenario: Malformed selector is submitted

- **WHEN** a selector cannot be validated as one available owner-visible connection or connector group
- **THEN** the server SHALL reject it with a typed invalid-selection error
- **AND** it SHALL NOT guess by truncating or partially parsing the selector.

### Requirement: Reference docs SHALL not teach URL ids as active keys

Reference implementation docs, operator copy, CLI help, MCP tool descriptions, and dashboard examples SHALL use canonical connector keys and connection ids. Manifest registry URIs MAY appear only as manifest provenance or registry links.

#### Scenario: Operator reads a setup example

- **WHEN** an operator reads a reference setup, consent, CLI, MCP, or local-collector example
- **THEN** the example SHALL use `connector_key` values such as `gmail`, `slack`, or `claude-code`
- **AND** it SHALL label any `https://registry...` value as `manifest_uri` or registry provenance, not as the operational connector id.

### Requirement: Post-migration active code SHALL not depend on legacy connector aliases

After the canonical connector-key migration lands, active reference code SHALL NOT require `legacy`, `legacy_default`, URL alias lookup, or stale local-collector alias equivalence to provide normal owner/client functionality.

#### Scenario: Owner opens the connection picker

- **WHEN** the owner opens the hosted MCP consent picker, connection dashboard, grant package flow, or event-subscription flow
- **THEN** stale alias rows SHALL NOT appear as selectable sources
- **AND** owner-visible labels SHALL be based on connector display name and connection display name, not on legacy storage markers.

#### Scenario: Runtime needs to classify old data

- **WHEN** code needs to mention old identifier shapes for migration diagnostics or tests
- **THEN** that code SHALL be isolated to migration, backup, or test fixtures
- **AND** normal runtime branches SHALL operate on canonical keys.
