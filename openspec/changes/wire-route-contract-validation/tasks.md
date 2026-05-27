## 1. Contract Package

- [ ] 1.1 Add response-validation support to `@pdpp/reference-contract` without changing request-validation callers.
- [ ] 1.2 Add contract-package tests for valid responses, invalid responses, missing operation ids, and non-JSON skip behavior.
- [ ] 1.3 Export only stable validation helpers from the package entrypoint.

## 2. Transport Boundary

- [ ] 2.1 Add a `reference-implementation/server/contract-validation` adapter that maps validation failures into existing PDPP error envelopes.
- [ ] 2.2 Wire request validation for every route mounted with a `{ contract }` operation id after route auth/owner middleware and before handlers.
- [ ] 2.3 Fail startup or tests when an annotated route references an unknown contract operation id.
- [ ] 2.4 Remove stale `contractValidation()` comments or claims that imply validation exists elsewhere.

## 3. Response Canary

- [ ] 3.1 Define an explicit response-validation allowlist for stable JSON metadata/discovery routes.
- [ ] 3.2 Validate canary responses by inspecting the outgoing payload without Fastify serialization, coercion, or field stripping.
- [ ] 3.3 Skip redirects, 204 responses, binary bodies, streams, server-sent events, and non-allowlisted JSON routes.

## 4. Acceptance Tests

- [ ] 4.1 Test malformed contract-route input rejects before handler mutation.
- [ ] 4.2 Test protected malformed requests still fail authentication before request validation.
- [ ] 4.3 Test invalid canary responses fail closed with a server-side contract error.
- [ ] 4.4 Test unsupported response shapes are not transformed or stripped.
- [ ] 4.5 Test operation modules remain free of Fastify, Express, storage, and reference-contract runtime imports.

## 5. Validation

- [ ] 5.1 Run `openspec validate wire-route-contract-validation --strict`.
- [ ] 5.2 Run reference-contract package tests and typecheck.
- [ ] 5.3 Run reference-implementation typecheck and the relevant route-validation tests.
- [ ] 5.4 Run the full reference-implementation test suite before merge.
