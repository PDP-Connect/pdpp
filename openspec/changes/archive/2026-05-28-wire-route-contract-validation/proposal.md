## Why

The reference contract package already defines request/response schemas and every mounted route carries a contract identifier, but runtime validation is not actually wired. This leaves the reference implementation with a false construction boundary: generated/docs/test contracts can drift from the HTTP server without being caught at the edge.

## What Changes

- Add transport-owned JSON request validation for an explicit allowlist of reference-contract operation ids.
- Add transport-owned JSON response validation for an explicit canary allowlist of stable metadata/discovery routes.
- Keep response validation out of Fastify serialization so schemas cannot silently strip live payload fields.
- Fail route registration when an annotated route references an unknown reference-contract operation id.
- Remove stale `contractValidation()` claims and make the transport layer the single route-contract validation boundary.
- Preserve existing handler-owned OAuth/PDPP rejection semantics (rich error codes, `param` hints, reference trace ids, spine events such as `client.register_rejected`) on routes that have not opted into transport-level request validation.
- Add tests proving auth ordering, invalid-request rejection on allowlisted routes, response canary failures, non-mutating pass-through, and operation boundary purity.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: route contract schemas become an enforced runtime boundary for request validation on an explicit allowlist of operation ids, with response validation introduced through a parallel canary allowlist. Other annotated routes continue to surface manifests for introspection/OpenAPI without runtime enforcement, so existing handler-owned semantics are preserved.

## Impact

- Affected packages: `packages/reference-contract`, `reference-implementation/server`, and reference-implementation tests.
- Public/reference APIs should not change for valid requests.
- Malformed requests on **request-validation allowlisted** routes may now fail earlier with structured `invalid_request` (OAuth-shaped or PDPP-shaped, per the manifest's declared 400 response) after applicable auth/owner guards.
- Malformed requests on routes NOT in the allowlist continue to hit the existing handler-owned diagnostics path, preserving rich semantics.
- Response validation starts narrowly to avoid broad schema-drift fallout; expanding the canary set is follow-up work after individual schemas are proven exact.
- Drift between `server/index.js` and `@pdpp/reference-contract` (an unknown operation id) now fails at route registration instead of silently disabling the boundary for that route.
