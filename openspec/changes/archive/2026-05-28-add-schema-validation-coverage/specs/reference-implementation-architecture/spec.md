## ADDED Requirements

### Requirement: Connectors SHALL build their `validateRecord` from a shared `makeValidateRecord` helper
The polyfill-connectors package SHALL provide a `makeValidateRecord(schemas)` helper that takes a stream-keyed registry of zod schemas and returns a `ValidateRecord` closure with consistent diagnostic shape (`{ ok: true, data }` on pass; `{ ok: false, issues: [{ path, message }, ...] }` on fail; pass-through `{ ok: true, data }` on unknown stream).

Every connector that ships a `schemas.ts` SHALL build its `validateRecord` from this helper rather than reimplementing the safeParse / unwrap / format-issues loop.

#### Scenario: A new connector author adds shape validation
- **WHEN** a connector author writes a `schemas.ts` for their connector
- **THEN** the file SHALL declare a stream-keyed `SCHEMAS` registry of zod schemas
- **AND** export `validateRecord = makeValidateRecord(SCHEMAS)` as the connector's validator
- **AND** SHALL NOT reimplement the safeParse / format-issues loop inline

#### Scenario: An unknown stream passes through
- **WHEN** the helper is invoked with a stream name not present in the registry
- **THEN** the helper SHALL return `{ ok: true, data }` without further checks
- **AND** the connector runtime SHALL emit the record normally
