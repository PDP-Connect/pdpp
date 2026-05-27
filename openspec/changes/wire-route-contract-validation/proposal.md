## Why

The reference contract package already defines request/response schemas and every mounted route carries a contract identifier, but runtime validation is not actually wired. This leaves the reference implementation with a false construction boundary: generated/docs/test contracts can drift from the HTTP server without being caught at the edge.

## What Changes

- Add runtime request validation for every route mounted with a reference-contract operation id.
- Add transport-owned JSON response validation for an explicit canary allowlist of stable metadata/discovery routes.
- Keep response validation out of Fastify serialization so schemas cannot silently strip live payload fields.
- Remove stale `contractValidation()` claims and make the transport layer the single route-contract validation boundary.
- Add tests proving auth ordering, invalid-request rejection, response canary failures, and unsupported response-shape bypasses.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: route contract schemas become an enforced runtime boundary for request validation, with response validation introduced through an explicit canary allowlist.

## Impact

- Affected packages: `packages/reference-contract`, `reference-implementation/server`, and reference-implementation tests.
- Public/reference APIs should not change for valid requests.
- Malformed requests that previously reached route handlers may now fail earlier with structured `invalid_request` errors after applicable auth/owner guards.
- Response validation starts narrowly to avoid broad schema-drift fallout; expanding the canary set is follow-up work after individual schemas are proven exact.
