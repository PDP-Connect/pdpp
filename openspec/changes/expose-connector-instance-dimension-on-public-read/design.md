## Context

A 2026-05-24 read-only audit (`tmp/workstreams/rh-item2-mcp-disambiguation-audit.md`) reviewed the MCP disambiguation bug report (Item 2). The audit established:

- There is no in-repo MCP server. Claude.ai's hosted MCP gateway translates MCP tool calls (`list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`) into PDPP REST calls against the resource server.
- PDPP's public read contract addresses data by stream name. No grant-authorized read endpoint (`rs-streams-list`, `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`) carries a `connector_instance_id` dimension on input, output, grant scope, or typed error.
- `connector_instance_id` is already first-class in storage (`reference-implementation/server/postgres-*.js`, `connector-instance-store.js`) and on operator-only surfaces (`ref-connectors-list/index.ts:43-46` returns `connector_display_name`, `connector_instance_id`, and per-instance `display_name`). But `ref/*` is operator-scoped and is not reachable by MCP clients or grant-authorized callers.
- The only user-reachable `ambiguous_connector_instance` error today is scheduler-side, at `reference-implementation/runtime/controller.ts:1994`. Users mis-attribute that error to MCP calls.
- Consent UI (`apps/web/src/components/pdpp/consent-card.tsx`, `apps/web/src/app/dashboard/grants/request/page.tsx`) has no instance dimension. A grant covering two Gmail accounts cannot distinguish them on the consent card.

The standing principle in `openspec/changes/define-connector-instances/specs/reference-implementation-architecture/spec.md` makes connector instance identity reference-runtime-only until a concrete interoperability need promotes it. MCP disambiguation is that need.

## Goals

- Make multi-instance disambiguation a first-class property of the public read contract.
- Let grant scope and consent UI express per-instance constraints.
- Preserve single-instance behavior for existing consumers that omit the filter.
- Make `display_name` owner-editable wherever the protocol surfaces it.
- Keep the change additive — no breaking removal of existing fields or routes.

## Non-Goals

- Do NOT change the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`. The new read-path error mirrors but does not replace it.
- Do NOT change the PDPP record envelope, manifest format, active-run invariant, or stream identity rules.
- Do NOT require every connector to expose multiple instances. Single-instance connectors SHALL keep their current request/response shape with `connector_instance_id` absent or carrying the deterministic single-instance value.
- Do NOT make `connector_instance_id` a required argument on any existing endpoint.
- Do NOT design the hosted MCP gateway's tool description updates in this change; coordinate them in the gateway's own repo.

## Design

### Read-Path Dimension

`rs.streams.list` response items SHALL include a `connector_instance_id` and an owner-meaningful `display_name`. For multi-instance deployments, stream entries SHALL appear once per (stream, connector_instance_id) pair. For single-instance deployments, the existing shape is preserved with the new fields populated from the sole active instance.

`rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, and `rs.blobs.read` SHALL accept an optional `connector_instance_id` parameter. When provided, the operation SHALL restrict its scan/lookup to that instance. When omitted on a stream that has multiple active instances under the caller's grant, the operation SHALL fail with the new typed read-path error rather than silently merging.

### Grant Scope Extension

`RecordsListGrant` and the search/blob-read peers SHALL accept an optional `connector_instance_id` per stream entry. A grant without the field SHALL preserve current cross-instance read semantics. A grant with the field SHALL constrain disclosure to records from that instance.

### Typed Read-Path Error

A new typed error `ambiguous_connector_instance` SHALL be emitted by read endpoints when a caller targets a stream that resolves to more than one active connector instance under the caller's grant and the caller did not pass `connector_instance_id`. The error envelope SHALL include `available_instances: [{ connector_instance_id, display_name }]` so a client can recover without an extra round trip. The HTTP/JSON-RPC mapping SHALL be defined alongside existing typed RS errors.

### Owner-Editable Display Name

`ref-connectors-list` already reads `display_name`. This change adds an owner-authenticated mutation to write it. The mutation SHALL live on the same operator surface as the existing connector-instance read; it SHALL NOT be exposed to grant-authorized clients. Promoting `display_name` to the public read contract without making it editable would freeze inherited labels (including the `legacy (pre-header)` string at `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`) onto a protocol surface, which would be a worse outcome than the current opacity.

### Consent UI

`consent-card.tsx` props SHALL gain an instance dimension. The card SHALL render scope rows grouped by connector type with per-instance sub-rows showing `display_name` when more than one instance falls under the grant. The request flow under `apps/web/src/app/dashboard/grants/request/` SHALL pass the dimension through. User-visible `legacy`/`default_account` text SHALL be removed.

### Migration Shape

This change is additive. The migration path:

1. Server begins populating `connector_instance_id` + `display_name` on all read responses.
2. Existing clients omitting the new filter continue to work against single-instance streams; multi-instance streams begin returning the new typed error.
3. Grant issuance UI begins offering per-instance scope; previously-issued grants continue to act as cross-instance.
4. Consent card adopts the new shape.
5. Owner-editable `display_name` mutation ships before clients can rely on the label being meaningful.
6. Hosted MCP gateway (out-of-repo) updates tool descriptions to advertise the new optional argument.

### Capability Placement

The read contract is currently described under `reference-implementation-architecture` (see `openspec/changes/mount-rs-streams-list-operation/specs/reference-implementation-architecture/spec.md` for the analogous shape). There is no `pdpp-core` capability in `openspec/specs/`, so this change places its spec delta on `reference-implementation-architecture`. If a future change introduces a `pdpp-core` capability for normative protocol surface, the read-path dimension and typed error should be lifted there at that time.

### MCP Gateway Coordination

The hosted MCP gateway (`mcp__claude_ai_Tim_s_Personal_Data_PDPP__*`) lives outside this repo. It needs to:

- accept `connector_instance_id` as an optional argument on `list_streams` output processing and on `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records` input;
- advertise the new argument in tool descriptions so LLM consumers know to pass it;
- propagate the new typed `ambiguous_connector_instance` error through MCP error semantics so clients can react.

That coordination is tracked in this change's tasks but is not gated by in-repo validation.

## Alternatives Considered

- **Keep `connector_instance_id` operator-only and force MCP clients through `ref/*`.** Rejected: grant-authorized clients (including the hosted MCP gateway) cannot reach `ref/*`. Disambiguation would require either a parallel grant-auth `ref/*` surface or accepting silent ambiguity. Both are worse than promoting the dimension.
- **Stack on `remove-legacy-connector-instances`.** Rejected: that change is purely storage-layer (`server/db.js`, `postgres-*.js`, `connector-instance-store.js`) and does not touch the public read contract, grant scope, consent UI, or owner mutations. Stacking would conflate orthogonal concerns and slow both branches.
- **Make `connector_instance_id` mandatory on multi-instance reads with no typed error.** Rejected: would break existing clients with no migration path. The typed error is the only client-friendly migration shape.
- **Surface raw connector-instance metadata (source binding details, credentials hash, device id) on the read contract.** Rejected: violates the "expose only what the contract needs" principle. `connector_instance_id` + `display_name` is the minimal addition that resolves the ambiguity.

## Acceptance Checks

- `openspec validate expose-connector-instance-dimension-on-public-read --strict`
- `openspec validate --all --strict`
- Spec delta covers: per-instance entries in `rs-streams-list` output; optional `connector_instance_id` filter on the read/search/blob operations; grant scope extension; typed `ambiguous_connector_instance` read-path error with `available_instances`; owner-authenticated `display_name` mutation; consent card per-instance render.
- Tasks list explicitly carries the external MCP-gateway coordination item without gating in-repo validation on it.
- No spec delta requires changes to the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`.
