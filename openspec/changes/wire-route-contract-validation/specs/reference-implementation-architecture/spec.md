## ADDED Requirements

### Requirement: Annotated routes SHALL enforce request contracts at runtime
The reference implementation SHALL validate incoming requests for every HTTP route mounted with a reference-contract operation id. Validation SHALL use the shared reference-contract schemas rather than server-local duplicate schemas.

#### Scenario: Malformed request on a contract route
- **WHEN** a caller sends a request whose params, query, headers, or body violate the route's declared reference-contract request schema
- **THEN** the reference implementation SHALL reject the request before the route handler mutates state or serves data
- **AND** the rejection SHALL use a structured PDPP error envelope with a request id.

#### Scenario: Protected route validation ordering
- **WHEN** an unauthenticated caller sends a malformed request to a protected contract route
- **THEN** authentication SHALL run before request-shape validation
- **AND** the response SHALL remain an authentication failure rather than leaking contract validation details.

### Requirement: Response validation SHALL be explicit and non-mutating
The reference implementation SHALL validate JSON responses only for routes explicitly enrolled in a response-validation allowlist. Response validation SHALL inspect the payload the handler intends to send and SHALL NOT serialize, strip, coerce, or otherwise transform the response.

#### Scenario: Canary response violates its schema
- **WHEN** an allowlisted contract route attempts to send a JSON response that violates its declared response schema
- **THEN** the reference implementation SHALL fail closed with a server-side contract error
- **AND** it SHALL NOT send the invalid payload as if it matched the contract.

#### Scenario: Non-JSON or non-allowlisted response
- **WHEN** a route sends a redirect, 204 response, binary body, stream, server-sent event, or a JSON response from a route not yet in the response-validation allowlist
- **THEN** response validation SHALL NOT transform or strip that response
- **AND** broader response validation SHALL require explicit enrollment after schema exactness is proven.

### Requirement: Route contract validation SHALL remain a transport boundary
Runtime route-contract validation SHALL live in the transport/HTTP adapter layer. Operation modules SHALL remain framework-independent and SHALL NOT import the reference-contract package solely to validate HTTP wire shapes.

#### Scenario: Operation boundary remains pure
- **WHEN** a route delegates to a canonical operation module
- **THEN** request and response validation SHALL be applied by the host adapter around the operation
- **AND** the operation module SHALL remain free of Fastify, Express, concrete storage, and reference-contract runtime dependencies.
