## Why

The MCP `schema` tool already projects a compact, token-efficient schema view
(`expose-connection-identity-on-public-read`, §7 "MCP schema token-efficiency").
That work lives entirely in the MCP presentation layer and explicitly changed no
RS contract. But the MCP gateway is not the only owner-agent REST consumer: a
trusted owner agent (and any agent that calls `GET /v1/schema` directly) still
receives the exhaustive RS body, which carries — for every field of every stream
of every connector under the grant — both the full per-field JSON Schema and the
verbose `{declared, usable}` capability sub-objects. On a representative grant
that body is hundreds of KB to multiple MB. That is too large as a default
agent-facing discovery payload and defeats the intended
`list_streams -> schema(stream) -> query_records` path on the REST surface the
same way it did on MCP.

This change adds the REST-side compact view so the token-efficiency win is
available to REST clients, not just MCP clients, without changing the default
body any existing client receives.

## What Changes

- `GET /v1/schema` keeps its current full/default behavior. Omitting `view`
  returns the exhaustive body verbatim.
- `GET /v1/schema?view=compact` returns a materially smaller projection of the
  schema document that preserves stream identity, per-connection identity
  (`granted_connections[].{connection_id, display_name}`, deprecated
  `connector_instance_id` alias where present), field names, declared types, and
  a single terse capability-flag string per field (declared type, grant, and
  usable filter/search/aggregation flags — the same vocabulary the MCP compact
  projection and the `content[]` summary advertise, e.g.
  `type=string,granted=true,exact,range=gte|lte,agg=count_distinct`). It drops
  the raw per-stream/per-field JSON Schema blobs and the verbose capability
  sub-objects. The envelope shape (`object: "schema"`, `bearer`, `connectors[]`)
  is preserved and a top-level `detail: "compact"` marker is added.
- `GET /v1/schema?view=compact&stream=<name>` narrows the document to a single
  stream so an agent can run the cheap middle step `schema(stream)` of
  `list_streams -> schema(stream) -> query_records`.
- Full detail remains opt-in/current: any other (or omitted) `view` value serves
  the current full body. No existing client loses fields by default. Compact is
  NOT the REST default in this tranche.
- Add enforceable byte-budget / structural acceptance tests modeled on the MCP
  schema compact tests, driving the real `/v1/schema` route from a registered
  manifest fixture (no live external data required).
- Update `@pdpp/reference-contract`, generated OpenAPI, and generated route docs
  so agents can discover `view=compact` / `stream=<name>` and validators can
  admit the compact response marker plus compact field-capability flag strings.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: the operation-owned `rs.schema.get`
  route gains an additive, opt-in compact projection selected by `view=compact`,
  optionally scoped to one stream by `stream=<name>`, with the full body
  preserved by default.

## Impact

- Additive change: existing consumers that omit `view` SHALL continue to receive
  the exhaustive body unchanged. The compact view is a strict opt-in.
- No change to the MCP `schema` compaction (that is the orthogonal presentation
  layer in `packages/mcp-server`); the REST flag vocabulary is intentionally the
  same so the two surfaces speak one terse capability language to agents.
- Public contract/doc impact is additive: the `getSchema` query contract names
  the compact selectors, and the response contract admits both the full
  field-capability object and the compact flag-string form. Compact is still not
  the default.
- No change to grant evaluation, visibility, connection identity, the deprecated
  `connector_instance_id` alias, the scheduler-side `ambiguous_connector_instance`
  behavior, or the record envelope. The compact view is a pure, read-only
  down-projection applied after the operation has produced the full body.
