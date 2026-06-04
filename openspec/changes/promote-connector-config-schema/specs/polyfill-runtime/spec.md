# polyfill-runtime (delta)

## ADDED Requirements

### Requirement: The runtime SHALL validate START connector_options against a declared options_schema

When a manifest declares an `options_schema`, the runtime SHALL shape-validate `START.connector_options` against it before spawning the connector, and SHALL fail the run with a named error when validation fails rather than silently dropping unknown options.

The connector runtime START message MAY include an optional
`connector_options` object carrying operator tuning knobs for the run.
`connector_options` is distinct from `scope` (which governs what data is
returned) and from credentials (which are secrets and SHALL NOT appear in
`connector_options`).

A polyfill manifest MAY declare an OPTIONAL `options_schema` (a JSON-Schema of
the connector's tuning knobs and their defaults).

This is reference-implementation / polyfill authoring and runtime metadata. It
SHALL NOT be treated as PDPP Core protocol semantics or as a Collection Profile
runtime requirement: `connector_options` remains optional on the wire and
`readOptions()` falls back to environment variables, so a zero-config connector
still runs. If portable option semantics are later needed across
implementations, the vocabulary SHALL be promoted through a separate Collection
Profile or companion-spec change.

#### Scenario: Connector declares options_schema and receives valid options

- **WHEN** a manifest declares `options_schema` and the runtime receives a
  `START` whose `connector_options` conforms to that schema
- **THEN** the runtime SHALL spawn the connector
- **AND** the validated `connector_options` SHALL be passed through to the
  connector (read via `readOptions`).

#### Scenario: connector_options fail options_schema validation

- **WHEN** a manifest declares `options_schema` and `START.connector_options`
  does not conform to it
- **THEN** the runtime SHALL fail the run before spawning the connector
- **AND** the error SHALL name the offending option field and the validation
  reason.

#### Scenario: No options_schema declared

- **WHEN** a manifest declares no `options_schema`
- **THEN** the runtime SHALL NOT validate `connector_options`
- **AND** the connector SHALL still run, reading any options via `readOptions`
  with its env-var fallback intact (backward compatible).

#### Scenario: Options are captured for run reproducibility

- **WHEN** a run begins with non-empty `connector_options`
- **THEN** the runtime SHALL capture the `connector_options` in the run spine so
  the run is reproducible
- **AND** the captured options SHALL be frozen for the duration of the run.

### Requirement: Credentials SHALL be declared separately from options and never carried as options

Credentials SHALL travel the dedicated credential path and SHALL NOT be carried in `START.connector_options`; a manifest SHALL NOT declare the same field name in both `options_schema` and `credentials_schema`.

A polyfill manifest MAY declare an OPTIONAL `credentials_schema` (a JSON-Schema
of the secrets the connector requires). The credential path is environment
variables today; grant-injected connector environment or stdin in a
multi-tenant deployment.

The runtime SHALL NOT persist credential values to the run spine or logs. The
no-overlap rule between `options_schema` and `credentials_schema` field names
prevents a secret being smuggled through the options channel. A build-time
honesty check SHALL enforce the no-overlap invariant and SHALL fail with the
offending connector name when violated.

This is reference-implementation / polyfill authoring and runtime metadata and
SHALL NOT be treated as PDPP Core protocol semantics or as a Collection Profile
runtime requirement.

#### Scenario: Manifest declares credentials_schema shape only

- **WHEN** a manifest declares `credentials_schema`
- **THEN** the schema SHALL describe only the shape of required secrets (field
  names, types) and SHALL NOT contain secret values
- **AND** the runtime SHALL source the actual values from the credential path,
  never from `connector_options`.

#### Scenario: Credentials never appear in the spine

- **WHEN** a connector run consumes credentials
- **THEN** credential values SHALL NOT appear in `spine_events.data_json` or run
  logs.

#### Scenario: Options and credentials field names overlap

- **WHEN** a manifest declares a field name in both `options_schema` and
  `credentials_schema`
- **THEN** the build-time honesty check SHALL fail
- **AND** the failure SHALL name the offending connector and field.
