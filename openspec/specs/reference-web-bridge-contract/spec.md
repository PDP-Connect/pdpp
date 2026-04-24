# reference-web-bridge-contract Specification

## Purpose
Define how website bridge routes consume the current reference AS/RS contract without teaching legacy helper routes, demo-only assumptions, or connector-only client access as durable PDPP behavior.
## Requirements
### Requirement: Web bridge routes reflect the current reference contract
Website bridge routes that call the reference implementation SHALL consume the current primary AS/RS surfaces and SHALL not require removed helper routes or connector-only request assumptions when the reference supports a source-aware contract.

#### Scenario: Source-aware grant bridge
- **WHEN** the website starts a PDPP client request through the reference AS
- **THEN** the bridge SHALL stage that request through the current PAR surface and SHALL allow either `connector_id` or `provider_id` according to the current reference contract rather than assuming connector-only input

#### Scenario: Legacy bridge routes remain explicitly non-authoritative
- **WHEN** a website bridge exists only to support a legacy or demo-only flow
- **THEN** that route SHALL remain explicit about its legacy/demo role and SHALL not imply that removed or non-primary surfaces are the current reference contract

### Requirement: Query bridges do not imply connector-only client access
Website query bridges SHALL treat connector scoping as optional implementation detail for polyfill-shaped reads and SHALL not document connector identifiers as universally required for client-token queries.

#### Scenario: Native or token-bound query
- **WHEN** the website bridges a record query driven by a grant-bound client token or native-provider path
- **THEN** the bridge SHALL work without requiring a public `connector_id` parameter

#### Scenario: Polyfill-scoped query
- **WHEN** the website bridges a polyfill-scoped query that still needs explicit source selection
- **THEN** the bridge MAY forward `connector_id`, but SHALL do so as realization-specific behavior rather than as the universal PDPP query model
