# MCP Instance Disambiguation On The Public Read Contract

Status: captured
Owner: reference implementation owner
Created: 2026-05-24
Updated: 2026-05-24
Related: `tmp/workstreams/rh-item2-mcp-disambiguation-audit.md`, `openspec/changes/remove-legacy-connector-instances`, `openspec/changes/define-connector-instances`, `apps/web/src/components/pdpp/consent-card.tsx`, `reference-implementation/operations/rs-streams-list/index.ts`, `reference-implementation/operations/rs-records-list/index.ts`, `reference-implementation/runtime/controller.ts` (the scheduler-side `ambiguous_connector_instance` at line 1994), `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx` (the user-visible `legacy (pre-header)` string at line 94)

## Question

Should PDPP's public read contract gain a `connector_instance_id` dimension (plus an owner-meaningful `display_name`) so that MCP/AI clients and consent UI can disambiguate multiple configured instances of the same connector type — e.g. two Claude Code devices, two Gmail accounts, two Codex collectors — without round-tripping through operator-only `ref/*` endpoints?

## Context

A 2026-05-24 read-only audit (`tmp/workstreams/rh-item2-mcp-disambiguation-audit.md`) was triggered by a bug report describing an MCP/AI client (Claude.ai's hosted PDPP gateway) seeing multiple Claude Code/Codex instances and producing confusing or ambiguous tool-call results unless the caller passed `connector_instance_id` explicitly.

The audit found that this is not a small fix on top of `remove-legacy-connector-instances`. Two structural facts:

1. **There is no MCP server in this repository.** Tool names `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records` appear only in narrative docs and commit message bodies. The user is talking to an upstream hosted MCP gateway (`mcp__claude_ai_Tim_s_Personal_Data_PDPP__*`) that translates MCP calls into PDPP REST calls. The disambiguation problem cannot be fixed inside an in-repo MCP server because there is no in-repo MCP server to fix.
2. **PDPP's grant + records contract is keyed on `stream`, not on `connector_instance_id`.** Every consumer-facing RS endpoint — `rs-streams-list`, `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read` — addresses data by stream name. There is no instance dimension in any request, response, grant scope, or consent card prop.

Where `connector_instance_id` does exist today (storage layer + operator-only surfaces):

- `reference-implementation/server/postgres-search.js`, `postgres-records.js`, `postgres-storage.js`, `records.js`, `search.js`, `db.js`.
- `reference-implementation/server/stores/connector-instance-store.js` (currently being cleaned up under `remove-legacy-connector-instances`).
- `reference-implementation/runtime/controller.ts:1994` — the only user-reachable `ambiguous_connector_instance` error today, and it is **scheduler-side**, not read-path: `Connector '${connectorId}' has multiple schedules; provide connector_instance_id.` This is what the user is mis-perceiving as an MCP ambiguity error. It fires when an owner schedules a run, not when Claude.ai calls `list_streams`.
- `reference-implementation/operations/ref-connectors-list/index.ts` already exposes `connector_display_name`, `connector_instance_id`, and a per-instance `display_name` — but `ref/*` is operator-only and is not visible to MCP clients or to grant-authorized clients.

The audit also flagged a user-visible `"legacy (pre-header)"` string in `deployment-diagnostics-view.tsx:94` inherited from the pre-instance era. That string is not load-bearing once instance identity becomes first-class on operator-visible surfaces.

## Stakes

If the public read contract does **not** gain an instance dimension:

- Every multi-instance connector forces MCP/AI consumers to either (a) accept arbitrary stream-name ambiguity, (b) emit duplicate-looking records with no protocol-level way to attribute them, or (c) round-trip through operator-only `ref/*` endpoints — which grant-authorized clients cannot reach.
- LLM consumers waste tokens on disambiguating prose ("which of the two Claude Code instances?") instead of structured arguments.
- The scheduler-side `ambiguous_connector_instance` error (controller.ts:1994) keeps leaking into user-visible flows because it is the only place that names the concept, even though it is the wrong surface to be naming it on.
- Consent UI cannot tell an owner that a grant covers `Gmail (work)` vs `Gmail (personal)` — both render as `Gmail`.

If the contract **does** gain an instance dimension:

- Once `display_name` is on the read contract, it must be owner-editable. There is currently no mutation endpoint for `connector_instance.display_name`; `ref-connectors-list` reads it but nothing writes it from the dashboard. That is a real gap, not a polish item, because the protocol surface would otherwise expose an unmodifiable inherited label.
- The upstream hosted MCP gateway (out-of-repo) needs to advertise the new optional argument in its tool descriptions; otherwise LLMs will not know to pass it.

## Boundary Map

- **Contract change (public spec):** `rs-streams-list` response items gain `connector_instance_id` + `display_name`. `rs-records-list`, `rs-search-{lexical,semantic,hybrid}`, `rs-blobs-read` accept an optional `connector_instance_id` filter. Grant scope shape (`RecordsListGrant` and peers) gains an optional `connector_instance_id` constraint. A new typed read-path error `ambiguous_connector_instance` lists `available_instances: [{ connector_instance_id, display_name }]`.
- **Reference server work:** thread the new dimension through `reference-implementation/operations/rs-*` and through grant evaluation; reject ambiguous reads symmetrically with the existing scheduler-side behavior; do not change the scheduler error.
- **Consent UI:** `apps/web/src/components/pdpp/consent-card.tsx` and the request flow under `apps/web/src/app/dashboard/grants/request/` render per-instance scope; drop inherited `legacy`/`default_account` text from any user-visible surface.
- **Owner mutation:** add an authenticated write endpoint for `connector_instance.display_name` so the protocol-surfaced label is owner-editable.
- **Hosted MCP gateway (out-of-repo):** update tool descriptions to advertise the optional `connector_instance_id` argument. Tracked as external coordination, not in-repo work.

## Standing Principle

Per `openspec/changes/define-connector-instances/specs/reference-implementation-architecture/spec.md`, multi-instance connector orchestration is currently treated as **reference runtime/orchestrator identity** rather than protocol surface — exactly because no concrete interoperability need had promoted it. This note argues that need now exists: any MCP/AI client speaking the public read contract against a multi-instance deployment cannot answer "which instance?" without protocol-level structure. That is the promotion trigger named in `define-connector-instances`.

Promotion is narrow: the contract gains an **optional** filter and a **descriptive** field. It does not change the active-run invariant, the manifest format, the scheduler-side ambiguity behavior, or core record envelope semantics.

## Decision Log

- 2026-05-24: Captured after Item 2 audit (`tmp/workstreams/rh-item2-mcp-disambiguation-audit.md`). Decision: do **not** stack on `remove-legacy-connector-instances` (which is purely storage-layer); open a separate protocol-surface OpenSpec change `expose-connector-instance-dimension-on-public-read` scoped to (a) read contract additions, (b) grant scope extension, (c) consent-card per-instance render, (d) owner-editable `display_name` mutation, (e) external MCP-gateway coordination. The change is additive on existing endpoints (no breaking removal) and should validate `--strict` before any implementation tranche is opened.
