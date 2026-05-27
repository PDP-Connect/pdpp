## ADDED Requirements

### Requirement: Annotated routes SHALL attach reference-contract manifests at registration
The reference implementation SHALL look up the `@pdpp/reference-contract` manifest for every HTTP route mounted with a `{ contract: '<operation id>' }` annotation. The lookup SHALL run at route registration so drift between the server and the contract package fails fast rather than silently.

#### Scenario: Unknown contract operation id
- **WHEN** a route is mounted with a `{ contract }` operation id that is not exported by `@pdpp/reference-contract`
- **THEN** the reference implementation SHALL throw at route registration
- **AND** SHALL identify the unknown operation id in the error message.

### Requirement: Allowlisted contract routes SHALL enforce request contracts at runtime
The reference implementation SHALL maintain an explicit allowlist of reference-contract operation ids whose annotated routes have transport-level request validation enforced. Validation SHALL use the shared reference-contract schemas rather than server-local duplicate schemas. The allowlist SHALL be defined in the server transport/adapter layer and SHALL NOT be inferred from the manifest alone.

#### Scenario: Malformed request on an allowlisted contract route
- **WHEN** a caller sends a request whose params, query, headers, or body violate the route's declared reference-contract request schema, and the route's operation id is in the request-validation allowlist
- **THEN** the reference implementation SHALL reject the request before the route handler mutates state or serves data
- **AND** the rejection SHALL use a structured error envelope with a request id, picking an OAuth-shaped or PDPP-shaped envelope based on the route manifest's declared 400 response schema.

#### Scenario: Protected route validation ordering
- **WHEN** an unauthenticated caller sends a malformed request to an allowlisted protected contract route
- **THEN** authentication SHALL run before request-shape validation
- **AND** the response SHALL remain an authentication failure rather than leaking contract validation details.

### Requirement: Non-allowlisted contract routes SHALL preserve handler-owned diagnostics
The reference implementation SHALL NOT pre-empt handler-owned rejection diagnostics on annotated routes that are outside the request-validation allowlist. Handler-emitted error codes (OAuth `invalid_client_metadata`, PDPP `invalid_status`, etc.), structured `param` hints, reference trace ids, and spine events such as `client.register_rejected` SHALL remain observable for malformed input.

#### Scenario: Malformed request on a non-allowlisted contract route
- **WHEN** a caller sends a request that violates the declared request schema on an annotated route NOT in the request-validation allowlist
- **THEN** the transport SHALL pass the request through to the route handler
- **AND** any handler-emitted error code, message, `param` hint, reference trace id, or spine event SHALL remain observable to clients and to `trace show`.

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
