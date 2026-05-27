## 1. Contract Package

- [x] 1.1 Add response-validation support to `@pdpp/reference-contract` without changing request-validation callers.
- [x] 1.2 Add contract-package tests for valid responses, invalid responses, missing operation ids, and non-JSON skip behavior.
- [x] 1.3 Export only stable validation helpers from the package entrypoint.

## 2. Transport Boundary

- [x] 2.1 Add a `reference-implementation/server/contract-validation` adapter that maps validation failures into existing PDPP / OAuth error envelopes.
- [x] 2.2 Maintain an explicit request-validation operation-id allowlist in the adapter alongside the response canary allowlist.
- [x] 2.3 Wire request validation in `transport.js` for allowlisted operations only, after route auth/owner middleware and before handlers.
- [x] 2.4 Fail at route registration when an annotated route references an unknown reference-contract operation id.
- [x] 2.5 Remove stale `contractValidation()` comments or claims that imply validation exists elsewhere.

## 3. Response Canary

- [x] 3.1 Define an explicit response-validation allowlist for stable JSON metadata/discovery routes.
- [x] 3.2 Validate canary responses by inspecting the outgoing payload without Fastify serialization, coercion, or field stripping.
- [x] 3.3 Skip redirects, 204 responses, binary bodies, streams, server-sent events, and non-allowlisted JSON routes.

## 4. Acceptance Tests

- [x] 4.1 Test malformed input on an allowlisted contract route is rejected before handler mutation, with an envelope shape matching the manifest's declared 400 response. (PDPP-shaped and OAuth-shaped, plus a positive control that valid bodies still reach the handler, exercised via the test-only `__requestValidationAllowlistForTest` injection on `createApp`.)
- [x] 4.2 Test protected malformed requests still fail authentication before request validation. (Route-level auth middleware runs first; malformed body never reaches the contract validator.)
- [x] 4.3 Test that non-allowlisted contract routes still surface handler-owned diagnostics (OAuth `invalid_client_metadata`, PDPP `invalid_status`, reference trace ids, `client.register_rejected` spine events) for malformed input. (Covered as positive-control matrix in the existing `pdpp.test.js`, `cli.test.js`, `run-interaction-control.test.js`, and `hosted-mcp-oauth.test.js` suites, which all continue to pass unchanged on this branch.)
- [x] 4.4 Test invalid canary responses fail closed with a server-side contract error.
- [x] 4.5 Test unsupported response shapes are not transformed or stripped.
- [x] 4.6 Test operation modules remain free of Fastify, Express, storage, and reference-contract runtime imports.
- [x] 4.7 Test that route registration throws when `{ contract }` names an unknown operation id.

## 5. Validation

- [x] 5.1 Run `openspec validate wire-route-contract-validation --strict`.
- [x] 5.2 Run reference-contract package tests and typecheck.
- [x] 5.3 Run reference-implementation typecheck and the relevant route-validation tests.
- [x] 5.4 Run the full reference-implementation test suite before merge.
