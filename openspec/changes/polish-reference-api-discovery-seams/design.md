## Context

The query/recall surface (records, search lexical/semantic/hybrid, aggregations, blobs) is in good shape. The seam where cold-start clients fail is the *uniform 404* at common entry points. The two fresh-eyes failures recorded in `tmp/pdpp-review-memo.md` both came from probing `/`, `/v1`, `/api/v1/...` and getting nothing — even though the well-known endpoint and `/v1/schema` already publish everything an integrator needs.

The minimum-leverage fix is to expose a tiny, unauthenticated index at `/` (on both AS and RS) that names the next hop. Anything that fits on one screen, in canonical PDPP shape, with no protocol invention.

The `polish-assistant-query-api-discovery` change already shipped:
- `GET /v1/schema` for one-shot capability/schema discovery,
- copy-pasteable docs for `streams[]`, `changes_since=beginning`, `blob_ref.fetch_url`, and aggregate calls,
- improved error messages naming `streams[]` for the wrong-shape filter case.

That change is good but lives behind a bearer. This change handles the *unauthenticated* surface a probe sees first.

## Design

### `GET /` — discovery index

Both AS and RS register an unauthenticated `GET /` route that returns a small JSON object:

```json
{
  "object": "pdpp_discovery_index",
  "role": "resource_server",                // or "authorization_server"
  "resource_name": "Peregrine Reference Provider",
  "links": {
    "well_known": "/.well-known/oauth-protected-resource",  // RS
    "well_known_authorization_server": "/.well-known/oauth-authorization-server", // AS
    "schema": "/v1/schema",                                  // RS only
    "core_query_base": "/v1"                                 // RS only
  },
  "reference_revision": "pdpp-reference@0.1.0+a06281fc8cae"
}
```

Each app emits the role-appropriate link set: AS emits `well_known_authorization_server`; RS emits `well_known`, `schema`, `core_query_base`. Both emit `reference_revision`.

The `object: "pdpp_discovery_index"` tag is namespaced so an LLM agent encountering the body recognizes the surface. The endpoint is unauthenticated and returns 200 even if the bearer flow is otherwise locked down.

The route does not duplicate the well-known content — it is a *pointer*, not the metadata document itself. A caller that follows the pointer to `/.well-known/oauth-protected-resource` gets the full capability advertisement.

### `pdpp_discovery_hints` in protected-resource metadata

The well-known protected-resource document already advertises capabilities; integrators still trial-and-error the *shape* of common requests. A small `pdpp_discovery_hints` block names canonical first-call shapes without inventing a protocol surface:

```json
{
  "pdpp_discovery_hints": {
    "schema_endpoint": "/v1/schema",
    "query_base": "/v1",
    "search": {
      "endpoint": "/v1/search",
      "scope_param": "streams[]",
      "filter_requires_single_stream": true
    },
    "aggregate": {
      "endpoint_template": "/v1/streams/{stream}/aggregate"
    },
    "changes_since_bootstrap": "beginning",
    "blob_indirection": "data.blob_ref.fetch_url",
    "hybrid_pagination_supported": false
  }
}
```

`hybrid_pagination_supported` mirrors `capabilities.hybrid_retrieval.cursor_supported` when the hybrid extension is published; otherwise it is omitted. The block is generated from runtime state (the same source the capability advertisements draw from) so it cannot drift from the live behavior.

This is additive: existing fields in the protected-resource metadata are unchanged.

### `PDPP_REFERENCE_REVISION` operational path

`resolveReferenceRevision` already honors `PDPP_REFERENCE_REVISION` and `opts.referenceRevision`. When a Docker image is built without `.git` (the default) the runtime returns `pdpp-reference@<package-version>+unknown`. The fix is to bake the revision in at image-build time using a build arg, then forward it as a runtime env var.

```dockerfile
ARG PDPP_REFERENCE_REVISION=unknown
ENV PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}
```

Operators pass `docker build --build-arg PDPP_REFERENCE_REVISION=$(git rev-parse --short=12 HEAD)` (or set it from CI env). The runtime continues to honor `PDPP_REFERENCE_REVISION` if set and falls back to git/package.json otherwise.

A test asserts the override is honored; the existing fallback test still covers the local dev path.

## Deferred Slices

The two memo items below are real contract changes and need their own focused proposals:

- **`connector_id` filter on `/v1/search`** — touches the `lexical-retrieval`, `semantic-retrieval`, and `hybrid-retrieval` capability specs (each currently states "no public connector_id parameter"). Owner-mode scoping needs new validation, error-class additions (`unknown_connector`?), and consistent semantics across all three search surfaces. Composing with `streams[]` and range filters is well-defined but needs explicit scenarios per capability.
- **`group_by` on `sum`/`min`/`max`** — touches `reference-implementation-architecture` aggregation requirements, the manifest declaration model (currently `query.aggregations.group_by` is a separate top-level allowlist that already permits any-metric grouping in the manifest, but the runtime restricts it to `count`), and the `aggregateRecords` per-group accumulator. Tractable but requires new bucket-ordering rules for non-count metrics.

Both are captured in `design-notes/connector-scoping-and-group-by.md` with the test surfaces they would need so a follow-up change can pick them up cleanly.

## Acceptance

- `GET /` on the AS port returns a discovery-index document naming the AS well-known endpoint and the running reference revision.
- `GET /` on the RS port returns a discovery-index document naming the RS well-known endpoint, `/v1/schema`, the core query base, and the running reference revision.
- `GET /.well-known/oauth-protected-resource` includes a `pdpp_discovery_hints` block whose values match the live behavior (schema endpoint, search/aggregate shape, bootstrap sentinel, blob indirection, hybrid pagination flag when applicable).
- A unit test asserts that `PDPP_REFERENCE_REVISION=foo` flows through to the response header and the discovery-index payload.
- The Dockerfile accepts a `PDPP_REFERENCE_REVISION` build arg and forwards it to the runtime so production images publish a real revision.
- The deferred connector-scoping / group_by slice is captured as a design note.
