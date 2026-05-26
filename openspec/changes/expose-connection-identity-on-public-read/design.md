## Classification under `canonicalize-public-read-contract`

This change is the **identity implementation slice** under the canonical public read contract.

The canonical contract owns the durable identity invariant: every record-bearing public read result SHALL be addressable as `(connection_id, stream, record_id)`, with `connector_instance_id` as a deprecated compatibility alias only. That invariant lives in `openspec/changes/canonicalize-public-read-contract/specs/reference-implementation-architecture/spec.md` (see "Public record identity SHALL be connection-scoped"). This change supplies the concrete contract additions, runtime threading, grant scope, consent surface, and MCP-forwarding work that realize the invariant.

What stays here (implementation slice):

- `connection_id` + `display_name` schema additions in `packages/reference-contract`.
- `rs-streams-list` per-(stream, connection_id) entries, optional `connection_id` filter on records/search/blob operations, fan-in default, exactly-one auto-select, typed `ambiguous_connection` error, grant-scope `connection_id`, owner-mode `display_name` mutation, consent-card per-connection render, MCP-side forwarding.

What is now owned upstream by the canonical contract:

- The normative requirement that public reads use `(connection_id, stream, record_id)` as canonical identity.
- The deprecation posture for `connector_instance_id` on the public surface.

No requirements are removed or duplicated here; the canonical contract states the rule, this change is the implementation. Deferred items called out in `tasks.md` remain the safe pickup point for the server-side fan-in/auto-select/ambiguous-error work that the canonical contract also expects to land.

## Context

A 2026-05-24 read-only audit (`tmp/workstreams/rh-item2-mcp-disambiguation-audit.md`) reviewed the MCP disambiguation bug report (Item 2). The audit established:

- There is no in-repo MCP server. Claude.ai's hosted MCP gateway translates MCP tool calls (`list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`) into PDPP REST calls against the resource server.
- PDPP's public read contract addresses data by stream name. No grant-authorized read endpoint (`rs-streams-list`, `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`) carries a connection dimension on input, output, grant scope, or typed error.
- `connector_instance_id` is already first-class in storage (`reference-implementation/server/postgres-*.js`, `connector-instance-store.js`) and on operator-only surfaces (`ref-connectors-list/index.ts:43-46` returns `connector_display_name`, `connector_instance_id`, and per-instance `display_name`). But `ref/*` is operator-scoped and is not reachable by MCP clients or grant-authorized callers.
- The only user-reachable `ambiguous_connector_instance` error today is scheduler-side, at `reference-implementation/runtime/controller.ts:1994`. Users mis-attribute that error to MCP calls.
- Consent UI (`apps/web/src/components/pdpp/consent-card.tsx`, `apps/web/src/app/dashboard/grants/request/page.tsx`) has no connection dimension. A grant covering two Gmail accounts cannot distinguish them on the consent card.

The standing principle in `openspec/changes/define-connector-instances/specs/reference-implementation-architecture/spec.md` makes connector instance identity reference-runtime-only until a concrete interoperability need promotes it. MCP disambiguation is that need.

## Goals

- Promote connection identity to a first-class public protocol noun: `connection_id` + `display_name`.
- Default to fan-in across granted connections so multi-connection reads are not falsely ambiguous.
- Emit a typed `ambiguous_connection` error only where fan-in is unsafe (record/blob identifier resolves to multiple connections under the grant).
- Auto-select the unique connection when the grant authorizes exactly one matching connection.
- Let grant scope and consent UI express per-connection constraints with owner-meaningful labels.
- Make `display_name` owner-editable wherever the protocol surfaces it.
- Preserve `connector_instance_id` as an internal storage identifier and a temporary wire alias; do not expose it as the primary public noun.
- Keep the change additive — no breaking removal of existing fields or routes.

## Non-Goals

- Do NOT change the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`. The new read-path error uses the canonical `connection` noun and lives in a different surface.
- Do NOT change the PDPP record envelope, manifest format, active-run invariant, or stream identity rules.
- Do NOT require every connector to expose multiple connections. Single-connection deployments preserve their current request/response shape, with `connection_id`/`display_name` populated from the sole active connection.
- Do NOT make `connection_id` a required argument on any existing endpoint.
- Do NOT design the hosted MCP gateway's tool description updates in this change; coordinate them in the gateway's own repo.
- Do NOT remove `connector_instance_id` from internal storage; it remains the durable orchestrator/runtime identifier.

## Design

### Canonical Public Noun

`connection` is the canonical public/operator/LLM-facing noun. A connection is one owner-configured concrete data source account/device/profile. The contract exposes:

- `connection_id`: opaque stable identifier (same opaque value as the existing internal `connector_instance_id`; the rename is at the contract layer, not the storage layer).
- `display_name`: owner-meaningful label, owner-editable through a new mutation. Renders as the primary connection label on consent, MCP responses, and the dashboard.

`connector_instance_id` remains a recognized internal identifier and a compatibility alias on the wire during the transition. The hosted MCP gateway and the contract registry SHALL advertise `connection_id` and `display_name`.

### Read-Path Dimension

`rs.streams.list` response items SHALL include `connection_id` and `display_name`. For multi-connection deployments, stream entries SHALL appear once per (stream, connection_id) pair. For single-connection deployments, the existing shape is preserved with the new fields populated from the sole active connection.

`rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, and `rs.blobs.read` SHALL accept an optional `connection_id` parameter.

### Fan-In Default

Omitting `connection_id` on a fan-in-capable operation SHALL NOT raise an ambiguity error. The operation SHALL return the union of records, streams, or hits across the connections the caller's grant authorizes for the addressed stream. Fan-in-capable operations are:

- `rs.streams.list` — already returns one entry per (stream, connection_id).
- `rs.records.list`, `rs.streams.detail` — union scan/aggregate across granted connections for the stream.
- `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid` — union hits across granted connections; each hit carries `connection_id` so callers can attribute it.

Each response item SHALL carry `connection_id` so callers can attribute fanned-in results. Pagination and ordering rules across the union are owned by the existing per-operation specs and are unchanged by this change.

### Exactly-One Auto-Select

If a grant authorizes exactly one matching connection for the addressed stream/identifier, omission of `connection_id` SHALL implicitly select that connection. No ambiguity error. No per-call argument needed. This applies uniformly to fan-in-capable and non-fan-in operations.

### Ambiguous-Connection Error

A new typed error `ambiguous_connection` SHALL be emitted by read endpoints when:

1. The operation cannot safely fan in. Specifically, `rs.records.detail` and `rs.blobs.read` address a record or blob by identifier; if the identifier resolves to more than one connection under the caller's grant, the operation SHALL fail with `ambiguous_connection`. Fan-in-capable operations SHALL NOT raise this error from connection multiplicity alone.
2. The error envelope SHALL include `available_connections: [{ connection_id, display_name }]` listing exactly the candidate connections within the caller's grant.
3. The error envelope SHALL include human-readable guidance: retry with `connection_id`.

The HTTP/JSON-RPC mapping SHALL be defined alongside existing typed RS errors.

### Grant Scope Extension

`RecordsListGrant` and the search/blob-read peers SHALL accept an optional `connection_id` per stream entry. A grant without the field SHALL preserve current cross-connection (fan-in) read semantics. A grant with the field SHALL constrain disclosure to records, hits, or blobs from that connection.

### Owner-Editable Display Name

`ref-connectors-list` already reads `display_name`. This change adds an owner-authenticated mutation to write it. The mutation SHALL live on the same operator surface as the existing connector-instance read; it SHALL NOT be exposed to grant-authorized clients. Promoting `display_name` to the public read contract without making it editable would freeze inherited labels (including the `legacy (pre-header)` string at `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`) onto a protocol surface, which would be a worse outcome than the current opacity.

### Consent UI

`consent-card.tsx` props SHALL gain a connection dimension. The card SHALL render scope rows grouped by connector type with per-connection sub-rows showing `display_name` when more than one connection falls under the grant. The request flow under `apps/web/src/app/dashboard/grants/request/` SHALL pass the dimension through. User-visible `legacy`/`default_account` text SHALL be removed from the primary label position; the rendered default for a never-renamed connection SHALL be an owner-meaningful string derived from connector type plus a stable disambiguator.

### `connector_instance_id` Compatibility

`connector_instance_id` remains the storage-layer column name and the orchestrator/runtime identifier. The reference server MAY:

- Accept `connector_instance_id` as a request-time alias for `connection_id` on the affected endpoints during a deprecation window. When both are present and refer to the same connection, the request SHALL succeed. When they refer to different connections, the request SHALL fail with a typed `invalid_argument` error.
- Emit `connector_instance_id` alongside `connection_id` on response envelopes during the deprecation window. Both fields SHALL carry the same opaque value.

The deprecation window closes once downstream consumers (hosted MCP gateway, dashboard, generated docs) have migrated. The schema for `connection_id` is normative; `connector_instance_id` on the wire is documented as deprecated.

### Migration Shape

This change is additive. The migration path:

1. Server begins populating `connection_id` + `display_name` on all read responses (and emits `connector_instance_id` alongside as a deprecated alias).
2. Existing clients omitting the new filter continue to work; multi-connection reads fan in by default; record/blob ambiguous reads return the new typed error.
3. Grant issuance UI begins offering per-connection scope; previously-issued grants continue to act as cross-connection (fan-in).
4. Consent card adopts the new shape with `display_name` as the primary label.
5. Owner-editable `display_name` mutation ships before clients can rely on the label being meaningful.
6. Hosted MCP gateway (out-of-repo) updates tool descriptions to advertise the new optional `connection_id` argument.
7. Once downstream consumers migrate, the `connector_instance_id` request alias and response companion are removed.

### Capability Placement

The read contract is currently described under `reference-implementation-architecture` (see `openspec/changes/mount-rs-streams-list-operation/specs/reference-implementation-architecture/spec.md` for the analogous shape). There is no `pdpp-core` capability in `openspec/specs/`, so this change places its spec delta on `reference-implementation-architecture`. If a future change introduces a `pdpp-core` capability for normative protocol surface, the public connection dimension and typed error should be lifted there at that time.

### MCP Gateway Coordination

The hosted MCP gateway (`mcp__claude_ai_Tim_s_Personal_Data_PDPP__*`) lives outside this repo. It needs to:

- Advertise `connection_id` as an optional argument on `list_streams` output processing and on `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records` input.
- Surface `display_name` in tool responses so LLM consumers can name the connection back to the owner.
- Propagate the new typed `ambiguous_connection` error through MCP error semantics so clients can react.

That coordination is tracked in this change's tasks but is not gated by in-repo validation.

## Alternatives Considered

- **Keep the canonical noun as `connector_instance_id`.** Rejected: the term leaks implementation structure (`instance` of a `connector`) into the public protocol and the LLM tool surface. The owner-facing concept is a connection — one configured account/device/profile. The contract should use the owner concept.
- **Error on every omitted `connection_id` in a multi-connection deployment.** Rejected: this is the previous draft's behavior and it makes natural fan-in operations falsely ambiguous. Fan-in is the correct default for list/search; the ambiguous error is only correct when a single identifier resolves to multiple connections.
- **Keep `connection_id` operator-only and force MCP clients through `ref/*`.** Rejected: grant-authorized clients (including the hosted MCP gateway) cannot reach `ref/*`. Disambiguation would require either a parallel grant-auth `ref/*` surface or accepting silent ambiguity. Both are worse than promoting the dimension.
- **Stack on `remove-legacy-connector-instances`.** Rejected: that change is purely storage-layer (`server/db.js`, `postgres-*.js`, `connector-instance-store.js`) and does not touch the public read contract, grant scope, consent UI, or owner mutations. Stacking would conflate orthogonal concerns and slow both branches.
- **Make `connection_id` mandatory on multi-connection reads with no typed error.** Rejected: would break existing clients with no migration path. Fan-in by default plus typed ambiguity on identifier-level ambiguity is the only client-friendly migration shape.
- **Surface raw connector-instance metadata (source binding details, credentials hash, device id) on the read contract.** Rejected: violates the "expose only what the contract needs" principle. `connection_id` + `display_name` is the minimal addition that resolves the ambiguity.

## Acceptance Checks

- `openspec validate expose-connection-identity-on-public-read --strict`
- `openspec validate --all --strict`
- Spec delta covers: canonical `connection` noun on the public contract; per-connection entries in `rs-streams-list` output; optional `connection_id` filter on the read/search/blob operations; fan-in default for list/search; exactly-one auto-select; typed `ambiguous_connection` error on record/blob identifier ambiguity with `available_connections`; grant scope extension; owner-authenticated `display_name` mutation; consent card per-connection render with no `legacy`/`default_account` leakage; `connector_instance_id` compatibility window.
- Tasks list explicitly carries the external MCP-gateway coordination item without gating in-repo validation on it.
- No spec delta requires changes to the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`.

## Deferred Items (as of branch `complete-storage-fan-in-read-contract`, 2026-05-26)

The contract, MCP server, consent-card, server-side rs-\* fan-in
threading, identifier-ambiguity emission, grant-scope `connection_id`
enforcement, and owner-mode `display_name` mutation now land end-to-end
in this tranche. The following items remain intentionally **deferred**;
each has a single safe pickup point:

1. **Cross-binding search fan-in.** Lexical / semantic / hybrid search
   currently runs a ranked snapshot per binding and the snapshot builder
   pins the binding at index time. Union search across bindings requires
   the snapshot/builder topology change — orthogonal to the records /
   list / detail / blob fan-in that this tranche delivers. The single-
   binding search path already carries `connection_id` per hit
   (`search-connection-identity.test.js`), so it interoperates with the
   fan-in resolver via explicit `connection_id` narrowing.

2. **Operator grant-request flow per-connection scope.** The
   grant-evaluation runtime already honors `grant.streams[].connection_id`
   (covered by `storage-fan-in-read-contract.test.js`); the
   operator-side UI to *issue* a grant constrained to a single
   connection still lives in `apps/web/src/app/dashboard/lib/
   operator-grant-request.ts`. Tracked under Section 4.

3. **Dashboard rename UI.** The owner can rename a connection via
   `PATCH /_ref/connections/:connectorInstanceId`. The corresponding
   inline rename control in
   `apps/web/src/app/dashboard/components/views/ref-connectors-view.tsx`
   is the safe next slice — backend mutation + grant evaluation are in
   place and verified to propagate to subsequent reads.

4. **Multi-connection consent-card render test.** Requires React testing
   infra in `apps/web` (Vitest + `@testing-library/react`). Out of scope
   for this branch; placeholder-rejection guards already live in the
   operation tests and the contract tests so the behavior is locked
   structurally while the visual harness catches up.

5. **Hosted MCP gateway tool descriptions.** External, out-of-repo. The
   in-repo MCP server (`packages/mcp-server`) is fully aligned and can
   serve as the reference implementation when the gateway PR is filed.
   The reference RS now emits the typed `ambiguous_connection` (HTTP
   409) envelope with `available_connections` + `retry_with` that the
   gateway needs to forward verbatim through MCP error semantics.

None of the deferred items invalidate the canonical noun, the field
shapes, the error envelope, or the consent surface — those are
contract-frozen and now runtime-honest end-to-end on the reference
implementation. The deferred work is pure UI / cross-binding search /
external-coordination plumbing against a stable contract.
