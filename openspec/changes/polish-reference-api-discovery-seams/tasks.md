## 1. Discovery Index

- [x] Add a contract entry for `GET /` (RS-side, unauthenticated) returning a small JSON pointer.
- [x] Add a contract entry for `GET /` (AS-side, unauthenticated) returning a small JSON pointer.
- [x] Implement the route in `buildAsApp` and `buildRsApp` ahead of any auth middleware.
- [x] Reuse `resolveReferenceRevision` so the index always reports the same revision the response header uses.
- [x] Add tests that cover: AS index shape, RS index shape, and that the index works without a bearer token.

## 2. Well-Known Discovery Hints

- [x] Extend `buildProtectedResourceMetadata` to accept and emit a `pdpp_discovery_hints` block.
- [x] Build the block from the same runtime state used for capabilities; expose: `schema_endpoint`, `query_base`, `search.{endpoint, scope_param, filter_requires_single_stream}`, `aggregate.endpoint_template`, `changes_since_bootstrap`, `blob_indirection`, and `hybrid_pagination_supported` when hybrid is advertised.
- [x] Update the contract response schema for `getProtectedResourceMetadata` to permit the new block.
- [x] Add a test that asserts the hints block is present on the canonical RS startup, and that `hybrid_pagination_supported` is omitted when hybrid is not advertised.

## 3. Reference Revision Operational Path

- [x] Add `ARG PDPP_REFERENCE_REVISION` and an `ENV PDPP_REFERENCE_REVISION` line in the `reference` Dockerfile stage so the build can bake a revision into the image.
- [x] Confirm `resolveReferenceRevision` honors `PDPP_REFERENCE_REVISION` (already implemented) and add a test that asserts the env override is reflected in the response header and the discovery-index body.
- [x] Document the build-arg path in the reference runbook (or the closest existing operator-facing doc).

## 4. Deferred Slice Capture

- [x] Write `design-notes/connector-scoping-and-group-by.md` capturing the deferred work, the affected specs, and the test scenarios a follow-up change should add.

## 5. Validation

- [x] Run `pnpm --dir reference-implementation exec node --test test/provider-metadata.test.js test/query-contract.test.js`.
- [x] Run `pnpm --filter @pdpp/reference-contract run check:generated` (and `verify` if generated docs change).
- [x] Run `pnpm --dir reference-implementation run verify`.
- [x] Run `openspec validate polish-reference-api-discovery-seams --strict`.
- [x] Run `openspec validate --all --strict`.
