## Context

The PDPP public read contract lives in `packages/reference-contract/src/public/index.ts` and is the single source of truth for the JSON Schema route manifests that the reference implementation, the hosted MCP integration, and the generated docs all consume. A recent fresh-eyes audit (RH Item 5, `tmp/workstreams/rh-item5-capability-contract-audit.md`) found the contract is structurally honest but has five small LLM-affordance gaps that each cost a cold-start agent one extra turn. None are protocol semantics; all are discoverability seams at the same layer that `polish-reference-api-discovery-seams` already worked on.

## Why one bundle and not five

Two reasons to bundle:

1. **Single review surface for a single audit.** All five items came out of the same audit, all touch `reference-implementation-architecture` requirements about how the public contract advertises itself to a cold-start caller, and all are additive. Splitting into five OpenSpecs would mostly produce identical proposal/design boilerplate and ask reviewers to context-switch five times for what is one cohesive "LLM-affordance pass."
2. **Acceptance is the same test surface.** Verification is one run of `pnpm --filter @pdpp/reference-contract run verify` plus contract regen plus the existing provider-metadata tests. The fixes share their acceptance gates.

Reason to NOT bundle (considered and rejected): the five items technically touch different sub-areas of the contract (`streams`, `records`, `search.*`, discovery hints, docs). But they remain a coherent slice because they are all additive, all driven by the same "honor-or-reject" alignment principle (the contract should honestly tell an LLM what works and what doesn't, before the LLM has to find out via a 400), and none individually warrants a standalone change folder.

If review feedback wants to split, the natural cut is two changes: (a) optional disambiguation fields on responses (items 1, 2), and (b) summary/description honesty (items 3, 4, 5). The current bundle is the smaller-blast-radius default.

## Alternatives considered

- **Per-fix OpenSpecs (5 changes).** Rejected — five copies of the same `Why` and `Impact`, five validation runs, no review benefit.
- **No OpenSpec, ship directly as a "small thing."** Rejected — `AGENTS.md` calls out that changes to `@pdpp/reference-contract` (a durable public contract) need OpenSpec even when small. The fixes are additive but they ship through the contract's generated artifacts and reach downstream consumers (hosted MCP descriptions, OpenAPI doc, dashboards).
- **Bundle the 5 low-risk fixes with the 5 OpenSpec-worthy larger fixes.** Rejected — the audit explicitly partitioned them, and the larger fixes (e.g. `connector_id` as a public search parameter, group-by on aggregates) are real contract changes requiring per-item design work. They will follow as separate proposals.

## Honor-or-reject alignment

The reference contract should either honor a caller's reasonable assumption or reject it with a self-teaching error. The five fixes pull the contract slightly further in the "honor" direction:

- `listStreams` and search results currently let a caller *see* a stream but not *know* which connector instance it came from when two instances of the same connector are registered. The fix honors the question without making the caller paginate `/v1/connectors`.
- `listStreams` and `getStreamMetadata` currently advertise a stream-level total but their summary does not warn that field-level filters live on a different endpoint. The fix tells the LLM where to look before it constructs a wrong call.
- Hybrid pagination is unavailable at runtime but the contract is silent. The fix advertises the limitation via a discovery hint that is *already shaped for it* (`ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported`).
- `ListRecordsQuerySchema.filter` is shape-only documented. The fix points at `/v1/schema` so a caller does not have to reverse-engineer the operator set per stream.

None of these change runtime semantics. They reduce 400-rate and round-trip count.

## Scope

In scope:

- Edits to `packages/reference-contract/src/public/index.ts` (description strings, optional field additions on response schemas).
- Edits to `reference-implementation/server/records.js` (`listStreams` mapper) and `reference-implementation/server/search.js` (search result mappers) to emit the new optional fields when an instance id is available.
- Edits to `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` (one short note).
- Tests covering: (a) `listStreams` emits `connector_instance_id` when two instances are registered, (b) search result items carry `connector_instance_id`, (c) `searchRecordsHybrid` summary references the discovery hint, (d) `hybrid_pagination_supported` is present whenever hybrid is advertised.

Out of scope:

- The five OpenSpec-worthy larger fixes (public `connector_id` on `/v1/search`, group-by, etc.) — separate proposals.
- Changes to request schemas (no new parameters accepted).
- Changes to hosted MCP tool registration on `claude.ai` — that surface re-syncs from the contract on its own cadence.
- Implementation work itself. This change is OpenSpec-only on this branch per the worker prompt; the implementation lands in a follow-up.

## Acceptance checks

- `openspec validate clarify-public-read-contract-llm-hints --strict` passes.
- `openspec validate --all --strict` passes (no regression in the broader spec set).
- When the follow-up implementation lands:
  - `pnpm --filter @pdpp/reference-contract run check:generated` passes after regen.
  - `pnpm --filter @pdpp/reference-contract run verify` passes.
  - `pnpm --dir reference-implementation run verify` passes.
  - `pnpm --dir reference-implementation exec node --test test/provider-metadata.test.js test/query-contract.test.js` passes, with new assertions added for the four scenarios above.

## Risks

- **Contract consumers double-counting the source.** Two fields (`connector_id` already present on search results; `connector_instance_id` newly added) could read like a redundant pair to a careless caller. Mitigation: keep the contract description explicit that `connector_id` identifies the registered connector and `connector_instance_id` identifies the *instance* of that connector (relevant when an owner has more than one). On `StreamListResponseSchema` we add both for symmetry with search results.
- **Discovery hint drift.** `hybrid_pagination_supported` must be sourced from the same runtime state that decides whether hybrid is advertised at all, or it can lie. Mitigation: spec requires it to be derived from the same capability advertisement state (precedent: `polish-reference-api-discovery-seams` does the same for other hints).
- **Generated docs churn.** The contract regen touches generated OpenAPI/MCP doc artifacts. Mitigation: regen and re-verify is part of the acceptance checks.
