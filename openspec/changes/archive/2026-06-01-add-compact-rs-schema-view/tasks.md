## 1. Spec Delta

- [x] Add an `ADDED Requirement` for the additive compact `GET /v1/schema` view under `reference-implementation-architecture`, covering: omitted-view full-body preservation, the compact identity-preserving projection, single-stream scoping, empty-on-unknown-stream, and the route-level down-projection boundary.
- [x] Run `openspec validate add-compact-rs-schema-view --strict` and `openspec validate --all --strict`.

## 2. Projection Module

- [x] Add a pure, typed projection module `reference-implementation/operations/rs-schema-get/compact-view.ts` that:
  - [x] preserves the `{ object, bearer, connectors[] }` envelope and per-connector metadata;
  - [x] preserves per-stream identity (`name`, `primary_key`, `cursor_field`, `source`) and connection identity (`granted_connections`, `connection_id` / `connector_instance_id` / `display_name` where present);
  - [x] collapses `field_capabilities.<field>` to a terse flag string (declared type, non-default grant flag, usable exact/range/lexical/semantic/aggregation flags) using REST compact aliases;
  - [x] compacts `expand_capabilities` to relation summary fields;
  - [x] drops the raw per-stream/per-field JSON Schema and other verbose blobs;
  - [x] adds a top-level `detail: "compact"` marker;
  - [x] supports `stream` scoping with recomputed `stream_count`.
- [x] Keep the module within the operation boundary (no Fastify/Next/SQLite/Postgres/raw-SQL/repository/`process.env` imports).

## 3. Route Wiring

- [x] Read `view` (case-insensitive, trimmed) and optional `stream` off `GET /v1/schema` in `server/routes/rs-read.ts` `mountRsSchema`.
- [x] Apply the projection after `executeSchemaGet` and before `finalizeCanonicalEnvelope`, only when `view=compact`.
- [x] Record `requested_view: "compact"` and the scoped connector/stream counts on the `disclosure.served` instrumentation; keep `query_shape: "schema"`.
- [x] Confirm the full body path is unchanged when `view` is omitted or non-compact.

## 4. Byte-Budget / Conformance Tests

- [x] Add `reference-implementation/test/rs-schema-compact-view.test.js` modeled on `packages/mcp-server/test/schema-token-budget.test.js`, driving the real `/v1/schema` route from a registered large-manifest fixture (no live data):
  - [x] fixture full body is large enough to model the problem;
  - [x] default (view omitted) stays full and current-compatible (raw JSON Schema present, no `detail` marker);
  - [x] `view=compact` stays under a documented byte budget and far smaller than full, carries `detail: "compact"`;
  - [x] `view=compact` drops per-field JSON Schema but keeps flags + `granted_connections`;
  - [x] `view=compact&stream=<name>` scopes to one stream under a tight budget;
  - [x] unknown stream scope yields an empty connector set, not an error;
  - [x] compact per-field cost stays bounded as field count grows.

## 4.1 MCP Compact Parity Follow-up

- [x] Add an `mcp-adapter` requirement delta requiring MCP `schema` compact/default output to align with `GET /v1/schema?view=compact` semantics while preserving `detail: "full"`.
- [x] Make the MCP `schema` compact/default path request `GET /v1/schema?view=compact` (and `stream=<name>` when scoped) before falling back to local projection.
- [x] Narrow the MCP local fallback to the same compact semantics as REST: compact flag aliases (`t`, `g=false`, `eq`, `r`, `lex`, `sem`, `a`) and connector-level shared `granted_connections` de-duplication.
- [x] Add tests proving MCP preserves the REST compact projection verbatim when supported and that the legacy full-schema fallback matches `projectSchemaCompactView`.

## 5. Validation

- [x] `pnpm --dir reference-implementation run typecheck`
- [x] `node --test test/rs-schema-compact-view.test.js`
- [x] Existing schema regression suites green (`rs-schema-get-operation`, `schema-granted-connections`, `schema-capability-truth`, `rs-schema-get-boundary`).
- [x] `git diff --check`

## 6. Live-Evidence Budget Tighten (granted_connections de-dup)

Codex live-smoked the deployed owner grant (2026-06-01) and found the compact
view did NOT meet its budget at real scale: `GET /v1/schema?view=compact`
returned 93,785 bytes and `view=compact&stream=messages` returned 7,626 bytes —
both over the 60,000 / 6,000 budgets. The synthetic fixture modeled one
connection, so it never exercised the dominant driver.

- [x] Root cause: the native RS attaches the SAME `granted_connections` array to every stream of a connector; the compact projection passed it through per stream, so a 19-connection grant's ~2 KB connection list was repeated once per stream — O(connections × streams).
- [x] De-duplicate `granted_connections` to the connector level in `compact-view.ts`: lift the set shared across a connector's streams to `connector.granted_connections`, drop the per-stream copy on streams that carry the shared set, and retain the per-stream array only where a stream's set diverges (a pinned-connection grant). Empty/absent sets are preserved verbatim.
- [x] Identity preserved: per-stream connection identity stays fully resolvable (connector-level set, or per-stream override when present); `connection_id`, `display_name`, and the deprecated `connector_instance_id` alias are not removed; connector ids are not forced URL-shaped.
- [x] Real-scale tests added to `rs-schema-compact-view.test.js`: a 19-connection grant across 12 streams, asserting (a) the shared list is lifted once to the connector level and not repeated per stream, (b) all-stream and single-stream compact stay under budget, (c) a non-vacuous failure mode — the body WITHOUT the lift (the pre-fix per-stream-duplicated shape) is materially larger, and (d) a divergent per-stream subset survives the lift.
- [x] Tighten the remaining real live byte driver after the lift: omit default `granted=true`, abbreviate field capability flags (`t`, `g=false`, `eq`, `r`, `lex`, `sem`, `a`), and omit per-stream object/freshness telemetry from the compact schema view.
- [x] Live full-schema projection evidence (Daisy owner token, 2026-06-01): applying the final projection to `https://pdpp.vivid.fish/v1/schema` yields `view=compact` 52,219 bytes and `view=compact&stream=messages` 5,453 bytes, under the 60,000 / 6,000 budgets.

## Acceptance Checks

- [x] `openspec validate add-compact-rs-schema-view --strict`
- [x] `openspec validate --all --strict`
- [x] `GET /v1/schema` default is byte-equivalent to prior behavior (no field loss).
- [x] `GET /v1/schema?view=compact` is materially smaller, identity-preserving, and drops raw JSON Schema. Evidence (6 streams x 30 fields fixture): full ~693 KB -> compact ~10 KB (~69x), per-stream compact ~1.9 KB.
- [x] Real-scale fixture evidence (12 streams x 30 fields x 19 connections): connector-level lift drops all-stream compact from ~40 KB (per-stream-duplicated) to ~20 KB; both all-stream and single-stream stay under budget.
- [x] Live-shape evidence from the deployed full schema: final compact projection measures 52,219 bytes all-stream and 5,453 bytes for `stream=messages`.
- [x] No `@pdpp/reference-contract` / OpenAPI / generated-artifact change.
