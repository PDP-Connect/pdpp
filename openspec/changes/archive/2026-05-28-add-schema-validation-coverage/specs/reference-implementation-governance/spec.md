## ADDED Requirements

### Requirement: Every connector with parsers SHALL ship `schemas.ts` covering every emitted stream
A polyfill connector that has a `parsers.ts` (or equivalent record-builder layer) and emits at least one stream SHALL ship a `schemas.ts` declaring zod schemas for every stream it emits, wired into the connector via `runConnector({ ..., validateRecord })` (or the equivalent custom emit path for connectors that don't use `runConnector`).

This is the §3 floor from `connector-authoring-guide.md`: a connector must never emit a record that looks right but is wrong. Without a per-stream zod schema, drift in upstream APIs, parser bugs, and accidentally-captured cruft land silently in the database, indistinguishable from valid data.

#### Scenario: A connector ships without schema coverage
- **WHEN** a connector with `parsers.ts` is reviewed
- **THEN** it SHALL have a `schemas.ts` declaring a schema for every stream it emits
- **AND** the connector SHALL wire `validateRecord` into its emit path so failed records become SKIP_RESULT events instead of RECORDs
- **AND** declared streams in the manifest SHALL match the keys present in the connector's `SCHEMAS` registry

#### Scenario: A connector adds a new emitted stream
- **WHEN** a connector starts emitting a previously-undeclared stream
- **THEN** the manifest SHALL declare the new stream in the same change that introduces emission
- **AND** the connector's `schemas.ts` SHALL declare a schema for the new stream

### Requirement: Schema coverage SHALL be validated against real owner data before commit
A new or modified `schemas.ts` SHALL be replayed against the local owner database (when records exist) before the change is committed. Schema-rejected records SHALL be inspected; the schema SHALL be loosened only when the rejection is a false positive, not when the connector is emitting bad data.

#### Scenario: A new schema is authored
- **WHEN** a connector author adds or modifies a `schemas.ts`
- **THEN** the author SHALL run `bin/replay-schemas.ts <connector>` against the local DB
- **AND** SHALL document any rejections in the change description
- **AND** SHALL NOT loosen the schema to mask data-quality issues; SKIP_RESULT is the diagnostic signal for those
