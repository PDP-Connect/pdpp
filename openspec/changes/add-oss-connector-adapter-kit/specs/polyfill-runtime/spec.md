# polyfill-runtime (delta)

## ADDED Requirements

### Requirement: OSS-wrapping connectors SHALL invoke external tools arms-length through the external-tool adapter

A connector that wraps an external OSS tool SHALL spawn that tool as an arms-length subprocess through the shared external-tool adapter rather than importing it as a library or hand-rolling its own spawn plumbing.

The connector SHALL declare every external tool it invokes in
`manifest.runtime_requirements.external_tools[]` with at least `name`,
`license`, `purpose`, and an `install_hint`; the declared `name` SHALL match the
tool name the connector references in source. A build-time honesty check SHALL
fail when a connector references a known external tool without declaring it.

The adapter SHALL resolve the tool binary from a connector-specific environment
override (e.g. `HPI_BIN`, `SLACKDUMP_BIN`) falling back to the tool name on
`PATH`, SHALL surface a clear missing-binary error naming the binary, the
override variable, and the install hint, and SHALL fail a run with the tool's
exit code and captured stderr on non-zero exit.

This is reference-implementation / polyfill authoring and runtime metadata and
SHALL NOT be treated as PDPP Core protocol semantics or as a Collection Profile
runtime requirement. The reference Docker image is not required to bundle any
wrapped tool; a deployment that uses a wrapped connector installs or mounts the
tool and sets its `*_BIN` override.

#### Scenario: A wrapped tool is missing

- **WHEN** a connector runs and its declared external tool binary is not found on
  PATH and no override variable is set
- **THEN** the run SHALL fail with an error naming the binary, the override
  environment variable, and the install hint
- **AND** the connector SHALL NOT fabricate records.

#### Scenario: A referenced tool is undeclared

- **WHEN** a connector's source references a known external tool but its manifest
  does not declare that tool in `runtime_requirements.external_tools`
- **THEN** the build-time honesty check SHALL fail
- **AND** the failure SHALL name the offending connector and tool.

#### Scenario: A wrapped tool emits records on stdout

- **WHEN** a wrapped tool emits a JSON array or JSONL on stdout
- **THEN** the adapter SHALL parse it into records, skipping non-object and
  non-JSON lines the tool may interleave.

### Requirement: A wrapping connector SHALL isolate per-stream failures from the run

A connector that exposes multiple streams from a wrapped tool SHALL treat a single stream's failure (e.g. an unconfigured upstream module) as a SKIP_RESULT for that stream rather than failing the whole run.

This keeps an OSS-family connector (one connector exposing many upstream modules,
e.g. HPI) usable when the owner has configured some upstream modules but not
others.

#### Scenario: One module is unconfigured

- **WHEN** a family connector queries several upstream modules and one is missing
  or unconfigured
- **THEN** that stream SHALL emit a SKIP_RESULT naming the failure
- **AND** the remaining streams SHALL still collect
- **AND** the run SHALL terminate with a success status.
