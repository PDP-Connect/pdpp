## Context

`@pdpp/reference-contract` defines JSON-Schema route manifests for public and reference routes, and `reference-implementation/server/index.js` mounts routes with `{ contract: "<operation id>" }`. `reference-implementation/server/transport.js` attaches those manifests to Fastify route schemas, but then disables Fastify validation and points at a non-existent `contractValidation()` middleware.

The result is a complected and misleading boundary: operation ids exist, generated OpenAPI can exist, and tests can assert route coverage, but the live server does not reject malformed requests through the shared contract package. Response schemas are even more sensitive because Fastify response schemas serialize through `fast-json-stringify`; if the schema is stale, fields can be stripped rather than merely flagged.

## Goals / Non-Goals

**Goals:**

- Make route contracts real at runtime for request validation.
- Preserve current auth ordering: protected routes authenticate before request-shape validation.
- Validate JSON responses on a deliberate canary set without stripping response fields.
- Keep operation modules framework/storage-free.
- Produce a path that can expand response validation after schemas are proven exact.

**Non-Goals:**

- Do not globally enable Fastify request/response validation.
- Do not migrate every response schema to exactness in this tranche.
- Do not change valid public/reference API behavior.
- Do not move validation into operation modules.
- Do not make Ultracite or full response-schema enforcement a CI gate in this tranche.

## Decisions

1. **Transport-owned validation boundary.**
   Runtime validation belongs in the server transport/adapter layer after route-specific middleware and before the final handler. This keeps contracts at the HTTP edge and keeps operations pure.

2. **Use `@pdpp/reference-contract` as the single validator source.**
   Extend the existing contract package rather than creating server-local AJV compilation. The server should call exported helpers such as `validateRequest` and `validateResponse`, while schema ownership remains in `packages/reference-contract`.

3. **Request validation applies to all annotated routes.**
   Every route with `{ contract }` should be request-validated through one generic mechanism. If an annotated route cannot pass validation, that is a contract drift bug to fix or explicitly document.

4. **Response validation starts with a canary allowlist.**
   Validate stable JSON metadata/discovery routes first. This catches construction issues without turning known response-schema drift into a broad failure or introducing silent payload stripping.

5. **No Fastify response serialization.**
   Response validation must inspect the payload the handler intends to send. It must not provide Fastify response schemas that can transform, coerce, or strip payloads.

6. **Fail closed with PDPP-shaped errors.**
   Invalid requests should use existing structured error envelopes with request ids. Invalid canary responses should fail closed as internal contract errors, not send a payload that violates the advertised contract.

## Risks / Trade-offs

- **Risk: existing request schemas are stale for some annotated routes.** → Mitigation: route validation exposes the drift immediately; fix schemas or route behavior as part of this tranche when validation fails.
- **Risk: response validation can expose substantial schema drift.** → Mitigation: explicit canary allowlist only; broaden after a route is proven exact.
- **Risk: validation ordering changes unauthenticated error semantics.** → Mitigation: append validation after auth/owner middleware, before the final handler.
- **Risk: large server/index.js route shape makes insertion brittle.** → Mitigation: install validation generically in `transport.js` using route contract metadata rather than editing every route.

## Migration Plan

1. Add `validateResponse` to `@pdpp/reference-contract`.
2. Add a server-side contract-validation adapter that maps request/response validator failures into existing PDPP error shapes.
3. Wire request validation generically for annotated routes in `transport.js`.
4. Wire response validation for the canary allowlist only.
5. Replace stale `contractValidation()` comments with the actual validation boundary.
6. Run targeted validation tests, typecheck, and the full reference suite.

Rollback is straightforward: disable the validation wrapper in `transport.js` while leaving contract package additions in place.

## Open Questions

- Which additional routes should enter the response-validation allowlist after this tranche? That should be decided route-by-route based on exact schema tests, not assumed globally.
