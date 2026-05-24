## Why

A capability-contract audit (`tmp/workstreams/rh-item5-capability-contract-audit.md`) found that the PDPP public read contract is one-shot-friendly *most* of the time, but a handful of small omissions cost an LLM caller an extra round trip per cold start. None of them are protocol semantics — they are missing operation-summary phrasing, discovery-hint wiring, and a parameter description that nudge an LLM caller toward the right next call. Hybrid pagination unavailability is enforced at runtime but is not advertised in the contract or the cookbook, so callers discover it via a 400. The `filter` shape on `/v1/records` is legal-syntax-only documented; the link to `/v1/schema` `field_capabilities` is implicit. Stream-level operations do not name `/v1/schema` as the place to learn field-level filter capabilities, so callers retry with bad `filter[...]` queries.

These fixes are operation-summary, discovery-hint, and JSON-Schema-`description` only. No request shape changes. No response field is removed or made required. They still touch `@pdpp/reference-contract` — a durable public contract — so they go through OpenSpec per `AGENTS.md`.

## Dependency on connection identity (Item 2)

A previous draft of this change carried two additional requirements: optional `connector_id` + `connector_instance_id` on `listStreams` items, and optional `connector_instance_id` on the lexical/semantic/hybrid search result items. Those overlap with the canonical connection identity contract owned by `expose-connection-identity-on-public-read` (RH Item 2). To avoid duplicating the same durable identity decision in two changes, the multi-connection disambiguation fields are NOT defined here; they are defined by Item 2 under the canonical `connection_id` + `display_name` shape.

This change depends on Item 2 for connection identity on response items. It does NOT redefine identity, attempt to ship a `connector_instance_id`-shaped variant, or assert anything about disambiguation that Item 2 does not already cover.

## What Changes

- Tighten the `listStreams` and `getStreamMetadata` operation `summary` strings to direct LLMs to `/v1/schema` first when they need field-level filters, so they do not burn a turn on a 400 from passing `filter[...]` to a stream-level endpoint.
- Populate `ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported` from live runtime state on every advertised hybrid surface and reference it from `searchRecordsHybrid.summary`; add a matching cookbook note under `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` telling callers to fall back to lexical when they need cursor pagination over hybrid.
- Clarify `ListRecordsQuerySchema.filter` `description` to point at `field_capabilities` from `/v1/schema` (exact: `filter[field]=value`; range: `filter[field][op]=value` where `op` comes from the declared `range_filter.operators`). Description only — no semantic change.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — the public read contract published via `@pdpp/reference-contract` gains two summary-string honesty requirements, one discovery-hint/cookbook pairing requirement, and one `filter` parameter description requirement.

## Impact

- Contract file: `packages/reference-contract/src/public/index.ts` — description and summary text updates on `listStreams`, `getStreamMetadata`, `searchRecordsHybrid`, and `ListRecordsQuerySchema.filter`. No field additions, no removals.
- Discovery hints: `reference-implementation/server/metadata.ts` already emits `hybrid_pagination_supported` when hybrid is advertised; this change asserts the wiring as a requirement and adds a contract reference from the hybrid operation summary.
- Docs: `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` — short note on hybrid cursor unavailability and lexical fallback.
- Generated artifacts: `pnpm --filter @pdpp/reference-contract run check:generated` / `verify` will need to re-run; downstream OpenAPI/MCP tool descriptions re-derive from the contract.
- Backwards compatibility: all changes are string-description and operation-summary edits plus a discovery-hint wiring assertion. No existing field is removed, renamed, or made stricter. Hosted MCP descriptions resync on their own cadence (out of scope).
- Identity work — adding a connection dimension to `listStreams` items and to search result items — is owned by `expose-connection-identity-on-public-read` and is NOT included here.
- Implementation is intentionally NOT in this branch. This OpenSpec change is the durable artifact; a follow-up change applies the edits.
