## Why

A cold-start integrator (human or agent) hitting the reference AS/RS today has no obvious entry point. Probing `/`, `/health`, `/v1` returns uniform 404s. Two independent fresh-eyes assessments (see `tmp/pdpp-review-memo.md`) both wasted significant time before reaching the well-known endpoint and `/v1/schema`. One observer concluded the server was non-functional. The recall surface, query API, and discovery endpoint behind the bearer are strong; the rough edges are at the *seam* an unauthenticated probe sees first.

Separately, `pdpp-reference-revision` ships as `pdpp-reference@0.1.0+unknown` whenever the runtime cannot find a `.git` directory (e.g. Docker images), even though `PDPP_REFERENCE_REVISION` is already honored as an override. Operators have no easy way to bake a real revision into image builds.

## What Changes

- Add an unauthenticated `GET /` JSON pointer on both AS and RS that names the well-known endpoint, the core query base, the schema endpoint, and the running reference revision.
- Add a `pdpp_discovery_hints` block to the resource-server protected-resource metadata document that explicitly names: the schema endpoint, the search/aggregate query bases, the `changes_since=beginning` bootstrap sentinel, the `streams[]` search-scope shape, and the `data.blob_ref.fetch_url` indirection for blob bytes.
- Document and exercise the `PDPP_REFERENCE_REVISION` build-arg/env path so Docker images can publish a real revision instead of `+unknown`. No code change; this slice closes the operational documentation gap, adds a test that the override is honored, and folds Docker build instructions into the runbook.
- Defer (with documented scope): a public `connector_id` filter on `/v1/search` and `group_by` on `sum/min/max` aggregations. Both are real contract changes touching `lexical-retrieval`, `semantic-retrieval`, `hybrid-retrieval`, and aggregate manifest declarations; they are too large for this slice without a separate design pass.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: add unauthenticated discovery-index requirement and well-known discovery-hint requirement.

## Impact

- `reference-implementation/server/index.js` — register `GET /` on AS and RS apps; emit `pdpp_discovery_hints` in protected-resource metadata.
- `reference-implementation/server/metadata.ts` — extend `buildProtectedResourceMetadata` with a `pdppDiscoveryHints` input.
- `reference-implementation/test/provider-metadata.test.js` — assert discovery index shape, well-known hints presence, and `PDPP_REFERENCE_REVISION` override path.
- `packages/reference-contract/src/public/index.ts` — register the discovery-index contract; extend protected-resource metadata response schema.
- generated OpenAPI/docs artifacts.
- `Dockerfile`, `docker-compose.yml` / `docker-compose.dev.yml` — accept and forward a `PDPP_REFERENCE_REVISION` build/runtime arg.
- `openspec/changes/polish-reference-api-discovery-seams/design-notes/connector-scoping-and-group-by.md` — deferred-design intake.
