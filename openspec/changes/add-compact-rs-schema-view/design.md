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
- Do NOT change `@pdpp/reference-contract` request/response schemas, OpenAPI, or
  generated artifacts. The compact view is a route-level down-projection of the
  existing response, not a new contract field.
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
  `cursor_field`, `source`). It omits route-unneeded stream telemetry such as
  the per-stream `object` marker and freshness timestamps; freshness belongs on
  list/health surfaces, while `schema(stream)` is the token-efficient
  field/capability discovery step.
- De-duplicates connection identity to the connector level: the
  `granted_connections` set shared across a connector's streams is emitted once
  as `connector.granted_connections`; per-stream copies survive only where a
  stream's set diverges (a grant pinning a connection subset). Connection
  identity (`connection_id` / `connector_instance_id` / `display_name`) is
  unchanged in shape — only its placement moves from per-stream to per-connector
  for the common case. See "Connection identity de-duplication" below.
- Collapses each `field_capabilities.<field>` to a terse flag string carrying
  the declared type, non-default grant flag, and every usable capability flag
  (exact/range/lexical/semantic/aggregation), dropping the raw per-field JSON
  Schema blob and the verbose `{declared, usable}` sub-objects.
- Compacts `expand_capabilities` to the relation summary fields an agent needs.
- Drops the heavy per-stream `schema`, `views`, `relationships`, and full
  `query` blobs.
- Adds a top-level `detail: "compact"` marker so callers can detect the
  projection without diffing.

The flag-string grammar uses explicit REST compact aliases: `t=<type>`, `g=false`
only for ungranted fields (`granted=true` is implicit), `eq`, `r=<ops>`, `lex`,
`sem`, and `a=<names>`. The aliases preserve the same logical capability bits as
the MCP compact projection, but avoid repeating verbose positive defaults across
hundreds of fields. The module lives in
`operations/rs-schema-get/compact-view.ts` and consumes the operation's flat
envelope.

### Connection identity de-duplication

Live evidence (Codex, 2026-06-01) showed the first cut did not meet its budget
at real scale: the deployed owner grant returned `view=compact` at 93,785 bytes
and `view=compact&stream=messages` at 7,626 bytes — both over the 60,000 / 6,000
budgets. The original synthetic fixture seeded a single connection, so it never
exercised the dominant driver.

Root cause: the native `rs.schema.get` host (`buildConnectorSchemaItem`)
computes the connector's connection list once and attaches the SAME
`granted_connections` array to every stream (narrowing only when a per-stream
grant pins a connection). The compact projection passed that array through per
stream, so the list was repeated once per stream — O(connections × streams). A
19-connection grant carries a ~2 KB connection list; across a dozen-plus streams
that is the bulk of the body.

Fix: lift the shared set to `connector.granted_connections` and drop the
per-stream copy on streams that carry it. The cost becomes O(connections +
streams) instead of O(connections × streams). Streams whose set diverges keep
their own array, so a pinned-connection grant loses no per-stream truth. The
shared set is chosen as the mode of the streams' connection sets (compared
order-insensitively by `connection_id`), which minimizes the per-stream
overrides that must remain. An agent reconstructs a stream's connection set as
"the stream's own `granted_connections` if present, else the connector-level
set" — the same identity, paid for once.

This lift alone was not enough for the live owner grant: after applying it to the
real deployed full schema, `view=compact` still measured 83,853 bytes and
`view=compact&stream=messages` measured 7,597 bytes. The remaining driver was
repeated verbose field flags (`type=...`, `granted=true`, `exact`, `range=...`)
across 1,107 fields. The accepted compact path therefore also omits
`granted=true`, abbreviates the capability flags, and drops freshness telemetry
from the schema view. Applied to the same live full schema, the projected body is
52,219 bytes for all streams and 5,453 bytes for `stream=messages`, under the
60,000 / 6,000 budgets without losing connection identity or capability bits.

### Placement and boundary

The projection module lives next to the operation
(`operations/rs-schema-get/compact-view.ts`) and obeys the same boundary rules:
no Fastify/Next/SQLite/Postgres/raw-SQL/repository/`process.env` imports. The
route (`server/routes/rs-read.ts` `mountRsSchema`) owns only the HTTP wiring:
reading `view` / `stream`, calling the projection, and recording the requested
view + scoped counts on the `disclosure.served` instrumentation. Visibility,
grant scope, and the full body remain operation-owned and untouched.

### Why a route-level projection, not a contract field

The compact body is a lossy view of the same response, not new data. Threading a
`detail` parameter through `@pdpp/reference-contract`, OpenAPI, and the generated
artifacts would freeze the projection's exact field set onto the durable public
contract, which is premature: the flag grammar is still co-evolving with the MCP
surface. A route-level projection keeps the contract stable while delivering the
token win, and the byte-budget tests lock the behavior structurally.

## Alternatives Considered

- **Reuse `detail=compact|full` (the MCP spelling) on REST.** Rejected for this
  tranche: the task target and the REST idiom is `view=`, and `GET /v1/schema`
  has no existing `detail` parameter. The semantics are identical; only the
  selector name differs across surfaces. (`view` collides in name only with the
  records-route projection selector, not in value space.)
- **Make compact the default and gate full behind `view=full`.** Rejected:
  would change the body every existing REST client receives with no migration
  path. Compact stays opt-in this tranche.
- **Add `detail` to the public contract + regenerate artifacts.** Rejected: see
  "Why a route-level projection" — premature contract freeze of a co-evolving
  flag grammar.
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
- `GET /v1/schema?view=compact&stream=<name>` scopes to one stream under a tight
  per-stream budget and remains usable.
- An unknown `stream` scope returns an empty connector set, not an error.
- The compact per-field cost stays bounded as field count grows.
- `granted_connections` is de-duplicated to the connector level: the shared set
  is emitted once on the connector and omitted from streams that carry it; a
  divergent per-stream set is retained.
- At real scale (a grant with ≥19 connections across multiple streams), the
  all-stream and single-stream compact views stay under their budgets, and the
  hypothetical per-stream-duplicated body (the pre-fix shape) is materially
  larger — a non-vacuous regression guard.
- Evidence (single-connection fixture: 6 streams x 30 fields, ~1.2 KB/field JSON
  Schema): full body ~693 KB, compact ~10 KB (~69x reduction), per-stream compact
  ~1.9 KB.
- Evidence (real-scale fixture: 12 streams x 30 fields x 19 connections): the
  connector-level lift drops all-stream compact from ~40 KB (per-stream-
  duplicated) to ~20 KB; both all-stream and single-stream stay under budget.
