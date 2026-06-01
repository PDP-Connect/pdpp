## Context

`expose-connection-identity-on-public-read` §7 ("MCP schema token-efficiency",
2026-05-31) landed a compact `schema` projection in the MCP server. That change
was deliberately scoped to the MCP presentation layer
(`packages/mcp-server/src/tools.js`) and changed no RS contract — "no RS
contract, OpenAPI, or `@pdpp/reference-contract` artifact changed". The RS
`GET /v1/schema` body it consumed remained the exhaustive document.

A trusted owner agent calling the REST surface directly (and any non-MCP REST
consumer) therefore still pays the full token cost. This change is the REST
follow-up: the same token-efficiency projection, exposed on the RS route as an
additive opt-in view.

## Goals

- Make `view=compact` a materially smaller, agent-usable schema projection on
  `GET /v1/schema`.
- Make `view=compact&stream=<name>` the cheap `schema(stream)` discovery middle
  step.
- Keep the full body the default; no existing client loses fields.
- Reuse the MCP compact flag vocabulary so REST and MCP agents read the same
  terse capability language.
- Add enforceable byte-budget acceptance checks that do not require live data.

## Non-Goals

- Do NOT make compact the REST default in this tranche.
- Do NOT change the MCP `schema` compaction (orthogonal layer; already landed).
- Do NOT make compact the REST default or change the meaning of the full schema
  response. The compact view is an additive route-level down-projection of the
  existing response.
- Do NOT change grant evaluation, visibility, connection identity, the
  deprecated `connector_instance_id` alias, or the record envelope.
- Do NOT include raw per-field/per-stream JSON Schema blobs in compact output.

## Design

### Selector

`GET /v1/schema?view=compact` selects the compact projection. The selector is
read case-insensitively after trimming; any other (or omitted) `view` value
serves the current full body. `view` here is the schema-render selector and is
distinct from the records-route `view` (a named manifest projection on
`GET /v1/streams/:stream/records`); the two routes do not share a value space.

`stream=<name>` optionally narrows the document to a single stream. It applies
to the compact path (the `schema(stream)` middle step) and is the same stream
name an agent reads from `list_streams` / the package-level compact summary.

### Projection

The compact projection is a pure transform of the operation's already-produced
`{ object: "schema", bearer, connectors[] }` response, applied at the route
**after** `executeSchemaGet` and before envelope finalization. It:

- Preserves the envelope shape: `object`, `bearer`, `connectors[]`, per-connector
  `connector_id` / `source` / `stream_count`.
- Per stream, preserves identity and addressing keys (`name`, `primary_key`,
  `cursor_field`, `source`), connection identity (`granted_connections`,
  `connection_id` / `connector_instance_id` / `display_name` where the entry
  carries them at stream level), and `freshness`.
- Collapses each `field_capabilities.<field>` to a terse flag string carrying
  the declared type, grant flag, and every usable capability flag
  (exact/range/lexical/semantic/aggregation), dropping the raw per-field JSON
  Schema blob and the verbose `{declared, usable}` sub-objects.
- Compacts `expand_capabilities` to the relation summary fields an agent needs.
- Drops the heavy per-stream `schema`, `views`, `relationships`, and full
  `query` blobs.
- Adds a top-level `detail: "compact"` marker so callers can detect the
  projection without diffing.

The flag-string grammar (`key=value` segments joined by `,`; bare flag names for
usable boolean capabilities; `range=<ops>` and `agg=<names>` for the
multi-valued ones) is the same vocabulary the MCP server emits, ported to a
typed RS module (`operations/rs-schema-get/compact-view.ts`). Sharing the
grammar — rather than the code — keeps the boundary clean: the RS module
consumes the operation's flat envelope, while the MCP module consumes the
`{ data: ... }`-wrapped body the package client sees.

### Placement and boundary

The projection module lives next to the operation
(`operations/rs-schema-get/compact-view.ts`) and obeys the same boundary rules:
no Fastify/Next/SQLite/Postgres/raw-SQL/repository/`process.env` imports. The
route (`server/routes/rs-read.ts` `mountRsSchema`) owns only the HTTP wiring:
reading `view` / `stream`, calling the projection, and recording the requested
view + scoped counts on the `disclosure.served` instrumentation. Visibility,
grant scope, and the full body remain operation-owned and untouched.

### Contract visibility

The compact body is a lossy view of the same response, not new data, but it is
still a public, agent-facing route behavior. The route contract therefore
documents the `view` and `stream` selectors and admits the compact response
marker plus compact field-capability flag strings. It does not make compact the
default and does not require consumers to hard-parse every flag segment. The
byte-budget tests lock the behavior structurally while preserving room for the
flag grammar to co-evolve with the MCP surface.

## Alternatives Considered

- **Reuse `detail=compact|full` (the MCP spelling) on REST.** Rejected for this
  tranche: the task target and the REST idiom is `view=`, and `GET /v1/schema`
  has no existing `detail` parameter. The semantics are identical; only the
  selector name differs across surfaces. (`view` collides in name only with the
  records-route projection selector, not in value space.)
- **Make compact the default and gate full behind `view=full`.** Rejected:
  would change the body every existing REST client receives with no migration
  path. Compact stays opt-in this tranche.
- **Keep the compact selector hidden from the public contract.** Rejected:
  agent-facing affordances should be discoverable by construction. The contract
  should at least advertise the selector and the response marker; otherwise
  generated OpenAPI and route docs tell agents only about the expensive full
  schema.
- **Compact in the operation instead of the route.** Rejected: the operation is
  the single source of the full, instrumented body; routes own request shaping
  and rendered detail. Keeping the projection at the route mirrors how the
  records route applies its own `view`/`fields` shaping post-operation.

## Acceptance Checks

- `openspec validate add-compact-rs-schema-view --strict`
- `openspec validate --all --strict`
- `GET /v1/schema` with `view` omitted returns the full body verbatim (raw
  per-field JSON Schema present; no `detail` marker).
- `GET /v1/schema?view=compact` stays under a documented byte budget, is far
  smaller than the full body, carries `detail: "compact"`, drops the raw
  per-field JSON Schema, and keeps stream identity, `granted_connections`, field
  names, declared types, and usable capability flags.
- `@pdpp/reference-contract`, generated OpenAPI, and generated route docs
  advertise `view=compact` / `stream=<name>` and admit the compact response
  marker + compact field-capability flag strings.
- `GET /v1/schema?view=compact&stream=<name>` scopes to one stream under a tight
  per-stream budget and remains usable.
- An unknown `stream` scope returns an empty connector set, not an error.
- The compact per-field cost stays bounded as field count grows.
- Evidence (this fixture: 6 streams x 30 fields, ~1.2 KB/field JSON Schema):
  full body ~693 KB, compact ~10 KB (~69x reduction), per-stream compact ~1.9 KB.
