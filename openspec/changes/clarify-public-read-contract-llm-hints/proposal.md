## Why

A capability-contract audit (`tmp/workstreams/rh-item5-capability-contract-audit.md`) found that the PDPP public read contract is one-shot-friendly *most* of the time, but five small omissions cost an LLM caller an extra round trip per cold start. None of them are protocol semantics — they are missing optional fields and operation-summary phrasing that nudge an LLM caller toward the right next call. Multi-instance disambiguation (`claude_code` connector with two instances) currently forces a `/v1/connectors` round-trip the contract does not need to make the caller take. Hybrid pagination unavailability is enforced at runtime but is not advertised in the contract or the cookbook, so callers discover it via a 400. The `filter` shape on `/v1/records` is legal-syntax-only documented; the link to `/v1/schema` `field_capabilities` is implicit.

These five fixes are doc/description/schema-shape only and additive (all new fields are optional). No request shape changes. No response field is removed or made required. They still touch `@pdpp/reference-contract` — a durable public contract — so they go through OpenSpec per `AGENTS.md`.

## What Changes

- Add optional `connector_id` and `connector_instance_id` to `StreamListResponseSchema.data.items` so an owner-token caller can disambiguate streams across multiple instances of the same connector in one call.
- Add optional `connector_instance_id` to the lexical, semantic, and hybrid search result item schemas (the originating `connector_id` is already there; the per-instance discriminator is missing).
- Tighten the `listStreams` and `getStreamMetadata` operation `summary` strings to direct LLMs to `/v1/schema` first when they need field-level filters, so they do not burn a turn on a 400 from passing `filter[...]` to a stream-level endpoint.
- Populate `ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported` from live runtime state on every advertised hybrid surface and reference it from `searchRecordsHybrid.summary`; add a matching cookbook note under `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` telling callers to fall back to lexical when they need cursor pagination over hybrid.
- Clarify `ListRecordsQuerySchema.filter` `description` to point at `field_capabilities` from `/v1/schema` (exact: `filter[field]=value`; range: `filter[field][op]=value` where `op` comes from the declared `range_filter.operators`). Description only — no semantic change.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — the public read contract published via `@pdpp/reference-contract` gains optional disambiguation fields, two summary-string honesty requirements, and one cookbook/discovery-hint pairing requirement.

## Impact

- Contract file: `packages/reference-contract/src/public/index.ts` — additive optional fields on `StreamListResponseSchema` items and on the three search response schemas; description and summary text updates on `listStreams`, `getStreamMetadata`, `searchRecordsHybrid`, and `ListRecordsQuerySchema`.
- Reference implementation: `reference-implementation/server/records.js` (`listStreams` mapper) and `reference-implementation/server/search.js` (lexical/semantic/hybrid result mappers) to emit the new optional fields.
- Discovery hints: `reference-implementation/server/metadata.ts` already emits `hybrid_pagination_supported` when hybrid is advertised; this change asserts the wiring as a requirement and adds a contract reference from the hybrid operation summary.
- Docs: `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` — short note on hybrid cursor unavailability and lexical fallback.
- Generated artifacts: `pnpm --filter @pdpp/reference-contract run check:generated` / `verify` will need to re-run; downstream OpenAPI/MCP tool descriptions re-derive from the contract.
- Backwards compatibility: all schema changes are additive optional fields and string-description changes. No existing field is removed, renamed, or made stricter. Hosted MCP descriptions resync on their own cadence (out of scope).
- Implementation is intentionally NOT in this branch. This OpenSpec change is the durable artifact; a follow-up change applies the edits.
