# Resolved — blob_id param-naming now aligned across spec, manifest, and server

**Status:** resolved 2026-04-22 during W7 polish. Originally raised during
W6 full-manifest route attachment.
**Scope:** `spec-core.md` §8 blob fetch URL template, the
`@pdpp/reference-contract` `getBlob` manifest, and
`reference-implementation/server/index.js` route path. No PDPP spec text
changed.

## Resolution (2026-04-22, W7)

W7 renamed the server's blob route param from `:blobId` to `:blob_id` in
both `GET /v1/blobs/:blob_id` and `HEAD /v1/blobs/:blob_id`. The
corresponding `req.params.blob_id` access was updated in the two handlers.
Internal local variables (`const blobId = ...`) keep their JavaScript
camelCase convention; the transport-visible wire name is now the
spec-correct `blob_id` everywhere.

After the change:

- Spec path template: `/v1/blobs/{blob_id}` ✅
- Contract manifest path + params: `/v1/blobs/{blob_id}`, `params.blob_id` ✅
- Server Fastify route: `/v1/blobs/:blob_id` ✅
- `fastify.printRoutes()` output: `/v1/blobs/:blob_id (GET, HEAD)` ✅

The test suite (459 tests) passed unchanged after the rename because
nothing except the server used the prior `:blobId` name.

## Original framing (kept for historical record)

## Summary

The three layers disagree on the blob path-param name:

- **Spec (`spec-core.md` §8)**: `GET /v1/blobs/{blob_id}` — snake_case.
- **Contract manifest (`packages/reference-contract/src/public/index.js`
  `getBlob`)**: `path: '/v1/blobs/{blob_id}'`; `request.params` property
  name is `blob_id`.
- **Server route (`reference-implementation/server/index.js` line
  2222)**: `app.get('/v1/blobs/:blobId', ...)`. Fastify binds the param
  under `req.params.blobId` (camelCase).

## Why it matters

Today W6 attaches the manifest's request-side schema to the Fastify route,
but the Fastify validator is disabled because PDPP error-envelope
formatting is owned by the `contractValidation()` middleware. That means
the param-name disagreement is not validated at runtime and doesn't break
tests. But it is a documentation/introspection truth gap:

- The generated OpenAPI artifact emits `/v1/blobs/{blob_id}`.
- Fastify's internal route table has `/v1/blobs/:blobId`.
- `fastify.printRoutes()` shows the route under the camelCase name.
- Anyone reading the manifest and the server side-by-side has to notice
  the divergence.

## Options

1. **Keep the spec as normative; change the server route** to
   `/v1/blobs/:blob_id` and rename the handler's local. Cheapest code
   change; no spec change; aligns runtime with spec wire template.
2. **Keep the server camelCase; change the spec** to `/v1/blobs/{blobId}`.
   Breaks existing consumers written to `blob_id`.
3. **Leave both; accept the naming mismatch as documentation-only.** Pure
   status-quo.

## Recommendation

Option 1. It's the lowest-blast-radius change that makes the three layers
agree, and the spec wire template is what external consumers see. But the
W6 supervisor directive was explicit that we should NOT reopen protocol
semantics as part of W6, and renaming the server route — even just to
match the spec — risks touching code paths that handler tests assume.
Parking this for a focused follow-up tranche.

## Cross-references

- `spec-core.md` §8 blob fetch.
- `packages/reference-contract/src/public/index.js` `getBlob` manifest.
- `reference-implementation/server/index.js` line 2222.
- `reference-implementation/server/transport.js` — `{ contract: 'getBlob' }`
  attaches the manifest's `params` schema for introspection; validation
  is bypassed so the naming disagreement doesn't surface as a runtime
  error today.
