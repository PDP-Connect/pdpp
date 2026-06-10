## Context

`@pdpp/reference-contract` defines JSON-Schema route manifests for public and reference routes, and `reference-implementation/server/index.js` mounts routes with `{ contract: "<operation id>" }`. `reference-implementation/server/transport.js` attaches those manifests to Fastify route schemas, but then disables Fastify validation and points at a non-existent `contractValidation()` middleware.

The result is a complected and misleading boundary: operation ids exist, generated OpenAPI can exist, and tests can assert route coverage, but the live server does not reject malformed requests through the shared contract package. Response schemas are even more sensitive because Fastify response schemas serialize through `fast-json-stringify`; if the schema is stale, fields can be stripped rather than merely flagged.

## Goals / Non-Goals

**Goals:**

- Make route contracts a real construction boundary at runtime.
- Preserve current auth ordering: protected routes authenticate before request-shape validation.
- Validate JSON responses on a deliberate canary set without stripping response fields.
- Keep operation modules framework/storage-free, with no runtime `@pdpp/reference-contract` import.
- Produce a path that can grow response and request validation coverage after schemas are proven exact.

**Non-Goals:**

- Do not globally enable Fastify request/response validation.
- Do not migrate every response schema to exactness in this tranche.
- Do not change valid public/reference API behavior.
- Do not move validation into operation modules.
- Do not make Ultracite or full response-schema enforcement a CI gate in this tranche.
- Do not downgrade existing handler-owned diagnostics (OAuth `invalid_client_metadata`,
  PDPP `invalid_status`, reference trace ids, `client.register_rejected` spine events)
  by letting a generic contract validator preempt them.

## Decisions

1. **Transport-owned validation boundary.**
   Runtime validation belongs in the server transport/adapter layer after route-specific middleware and before the final handler. This keeps contracts at the HTTP edge and keeps operations pure.

2. **Use `@pdpp/reference-contract` as the single validator source.**
   Extend the existing contract package rather than creating server-local AJV compilation. The server should call exported helpers such as `validateRequest` and `validateResponse`, while schema ownership remains in `packages/reference-contract`.

3. **Request validation is opt-in per route via an explicit allowlist.**
   Several existing handlers (OAuth DCR, PAR, run-interaction control, several `_ref/...`
   endpoints) emit rich semantic diagnostics on shape rejection: OAuth `invalid_client_metadata`
   codes, PDPP `invalid_status` codes, structured `param` hints, reference trace ids, and
   spine events such as `client.register_rejected`. Pre-empting those handlers with a
   generic transport-level `invalid_request` envelope erases observability that the CLI,
   spine trace, and standards reviewers depend on.

   This tranche therefore wires request validation through an **explicit allowlist of
   operation ids** — mirroring the response allowlist — rather than across every annotated
   route. Routes in the allowlist are those whose handlers do not emit richer wire-shape
   diagnostics on rejection, so the transport's structured `invalid_request` envelope is
   the load-bearing observable. The allowlist is small in this tranche; expansion is
   per-route follow-up after each handler is proven shape-only or after equivalent
   diagnostics are emitted from the validation boundary.

   The runtime contract itself (`contract: '<opId>'`) is unchanged: every annotated route
   still has its manifest attached to the Fastify route definition for introspection,
   OpenAPI emission, and tests. Only the **enforcement** of request validation is opt-in.

4. **Response validation starts with a canary allowlist.**
   Validate stable JSON metadata/discovery routes first. This catches construction issues without turning known response-schema drift into a broad failure or introducing silent payload stripping.

5. **No Fastify response serialization.**
   Response validation must inspect the payload the handler intends to send. It must not provide Fastify response schemas that can transform, coerce, or strip payloads.

6. **Fail closed with PDPP-shaped errors.**
   Invalid requests on allowlisted routes use existing structured error envelopes with
   request ids. The transport adapter picks `OAuth`-shaped vs `PDPP`-shaped envelopes
   from the route manifest's declared 400 response schema so allowlisted DCR/OAuth routes
   never receive a PDPP envelope. Invalid canary responses fail closed as internal
   contract errors and never send a payload that violates the advertised contract.

7. **Unknown operation ids fail at startup.**
   A route annotated with `{ contract: 'opId' }` whose operation id is not in
   `@pdpp/reference-contract` throws at route registration. This catches drift between
   `server/index.js` and the contract package immediately, before any request arrives.

## Risks / Trade-offs

- **Risk: request-validation coverage starts narrow.** → Accepted: the alternative (broad
  enforcement) demonstrably erases handler-owned OAuth/PDPP semantics. Expansion is
  per-route follow-up.
- **Risk: response validation can expose substantial schema drift.** → Mitigation: explicit canary allowlist only; broaden after a route is proven exact.
- **Risk: validation ordering changes unauthenticated error semantics.** → Mitigation: append validation after auth/owner middleware, before the final handler.
- **Risk: large server/index.js route shape makes insertion brittle.** → Mitigation: install validation generically in `transport.js` using route contract metadata rather than editing every route.
- **Risk: enrollment is invisible at the route call site.** → Mitigation: enrollment lives
  in `server/contract-validation.js` alongside the response canary, named explicitly per
  operation id with a comment naming each route's handler-side responsibility.

## Migration Plan

1. Add `validateResponse` to `@pdpp/reference-contract`.
2. Add a server-side contract-validation adapter that maps request/response validator failures into existing PDPP / OAuth error shapes.
3. Wire request validation generically in `transport.js` for the request-validation allowlist only.
4. Wire response validation for the canary allowlist only.
5. Fail route registration when an annotated route references an unknown contract operation id.
6. Replace stale `contractValidation()` comments with the actual validation boundary.
7. Run targeted validation tests, typecheck, and the full reference suite.

Rollback is straightforward: shrink the request- and response-validation allowlists in
`server/contract-validation.js` to empty sets while leaving the contract package additions
in place.

## Open Questions

- Which additional routes should enter the request-validation allowlist after this tranche? That should be decided route-by-route based on whether each handler still emits richer semantic diagnostics.
- Which additional routes should enter the response-validation allowlist after this tranche? That should be decided route-by-route based on exact schema tests, not assumed globally.
