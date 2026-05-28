## Classification under `canonicalize-public-read-contract`

This change is **largely superseded** by the canonical public read contract. The concrete contract description/test/cookbook edits already landed on `main` and remain valid implementation evidence.

The canonical contract owns the durable requirements that subsume the original intent:

- "`GET /v1/schema` is the canonical capability/introspection surface for streams, fields, operators, sortability, expansion, search modes, pagination, count support, and granted connections." — replaces the bespoke "point summaries at `/v1/schema`" intent.
- "Public read parameters SHALL be strictly validated" with structured `meta.warnings` — replaces the bespoke "hybrid pagination unavailable" hint pattern; under the canonical contract, capability is advertised in `/v1/schema` and unsupported cursor use is rejected (or warned) rather than discovered via 400.
- "Public read filters SHALL use a small advertised operator vocabulary" — replaces the bespoke `filter` description hint; canonical operators are advertised per field in `/v1/schema`.
- "MCP tool descriptions and docs may summarize this information, but they do not become a second source of truth." — applies to the summary edits here.

What remains here as implementation evidence: the actual `summary`/`description` edits in `packages/reference-contract/src/public/index.ts`, the cookbook hybrid-pagination fallback note, and the `llm-hints.test.js` guard. Those are not contradicted by the canonical contract; they are concrete realizations of canonical capability discovery for the current pre-canonical wire shape.

No additional requirements are introduced here. New normative requirements for capability discovery, advertised operators, and `/v1/schema` authority belong in `canonicalize-public-read-contract`.

## Context

The PDPP public read contract lives in `packages/reference-contract/src/public/index.ts` and is the single source of truth for the JSON Schema route manifests that the reference implementation, the hosted MCP integration, and the generated docs all consume. A recent fresh-eyes audit (RH Item 5, `tmp/workstreams/rh-item5-capability-contract-audit.md`) found the contract is structurally honest but has a handful of small LLM-affordance gaps that each cost a cold-start agent one extra turn. None are protocol semantics; all are discoverability seams at the same layer that `polish-reference-api-discovery-seams` already worked on.

The original audit listed five seams. Two of those — adding optional connection identity to `listStreams` items and to search results — overlap with the canonical connection identity work owned by `expose-connection-identity-on-public-read` (RH Item 2). The owner directive bars duplicating durable identity decisions across changes, so this change explicitly excludes the identity fixes and depends on Item 2 for them. The remaining three seams (summary honesty, hybrid pagination hint, `filter` description) are token-efficiency/schema-discovery hints that do NOT touch identity.

## Dependency on Item 2 (canonical connection identity)

Item 2 (`expose-connection-identity-on-public-read`) defines the canonical `connection` noun, the `connection_id` + `display_name` fields on `rs.streams.list` and search results, the fan-in vs ambiguous-connection rules, and the per-connection consent label requirement. This change MUST NOT redefine those fields, propose a `connector_instance_id`-shaped alternative, or assert anything about multi-connection disambiguation that Item 2 does not already cover.

Implementation order: this change SHOULD apply on top of Item 2's contract changes. When the follow-up implementation tranche lands, the same `listStreams` and search response schemas already carry `connection_id`/`display_name` from Item 2; this change only edits summaries, hints, and parameter descriptions.

## Why one bundle and not three

The three remaining items came out of the same audit, all touch `reference-implementation-architecture` requirements about how the public contract advertises itself to a cold-start caller, and all are additive description/hint edits. Splitting into three OpenSpecs would mostly produce identical proposal/design boilerplate. Acceptance is the same test surface (`@pdpp/reference-contract verify` + contract regen + the existing provider-metadata tests). The bundle is the smaller-blast-radius default.

## Alternatives considered

- **Per-fix OpenSpecs (3 changes).** Rejected — three copies of the same `Why` and `Impact`, three validation runs, no review benefit.
- **No OpenSpec, ship directly as a "small thing."** Rejected — `AGENTS.md` calls out that changes to `@pdpp/reference-contract` (a durable public contract) need OpenSpec even when small. The fixes ship through the contract's generated artifacts and reach downstream consumers (hosted MCP descriptions, OpenAPI doc, dashboards).
- **Keep the original 5-item bundle including the identity fixes.** Rejected — duplicates Item 2's durable identity decision. The owner directive bars this.
- **Bundle these hints with the OpenSpec-worthy larger contract fixes.** Rejected — the audit explicitly partitioned them, and the larger fixes (e.g. group-by on aggregates) are real contract changes requiring per-item design work.

## Honor-or-reject alignment

The reference contract should either honor a caller's reasonable assumption or reject it with a self-teaching error. The three fixes pull the contract slightly further in the "honor" direction:

- `listStreams` and `getStreamMetadata` currently advertise a stream-level total but their summary does not warn that field-level filters live on a different endpoint. The fix tells the LLM where to look before it constructs a wrong call.
- Hybrid pagination is unavailable at runtime but the contract is silent. The fix advertises the limitation via a discovery hint that is *already shaped for it* (`ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported`).
- `ListRecordsQuerySchema.filter` is shape-only documented. The fix points at `/v1/schema` so a caller does not have to reverse-engineer the operator set per stream.

None of these change runtime semantics. They reduce 400-rate and round-trip count.

## Scope

In scope:

- Edits to `packages/reference-contract/src/public/index.ts`: `listStreams.summary`, `getStreamMetadata.summary`, `searchRecordsHybrid.summary`, and `ListRecordsQuerySchema.filter.description`. No field additions, no removals.
- Wiring assertion: `ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported` (already declared at the contract layer and emitted by `reference-implementation/server/metadata.ts`) SHALL be derived from the same capability advertisement state used to decide whether hybrid is advertised at all, and SHALL be omitted (not `false`-defaulted) when hybrid is not advertised.
- Edits to `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` (one short note on hybrid cursor unavailability and lexical fallback).
- Tests covering: (a) `listStreams` / `getStreamMetadata` summaries name `/v1/schema`, (b) `searchRecordsHybrid` summary references `pdpp_discovery_hints.hybrid_pagination_supported`, (c) `hybrid_pagination_supported` is present whenever hybrid is advertised and omitted otherwise, (d) `ListRecordsQuerySchema.filter.description` names `/v1/schema` and `field_capabilities`.

Out of scope:

- Connection identity on `listStreams` items, search result items, or anywhere else on the read contract. Owned by Item 2.
- Changes to request schemas (no new parameters accepted).
- Changes to hosted MCP tool registration on `claude.ai` — that surface re-syncs from the contract on its own cadence.
- Implementation work itself. This change is OpenSpec-only on this branch; the implementation lands in a follow-up.

## Acceptance checks

- `openspec validate clarify-public-read-contract-llm-hints --strict` passes.
- `openspec validate --all --strict` passes (no regression in the broader spec set).
- When the follow-up implementation lands:
  - `pnpm --filter @pdpp/reference-contract run check:generated` passes after regen.
  - `pnpm --filter @pdpp/reference-contract run verify` passes.
  - `pnpm --dir reference-implementation run verify` passes.
  - `pnpm --dir reference-implementation exec node --test test/provider-metadata.test.js test/query-contract.test.js` passes, with new assertions added for the four scenarios above.

## Risks

- **Discovery hint drift.** `hybrid_pagination_supported` must be sourced from the same runtime state that decides whether hybrid is advertised at all, or it can lie. Mitigation: spec requires it to be derived from the same capability advertisement state (precedent: `polish-reference-api-discovery-seams` does the same for other hints).
- **Generated docs churn.** The contract regen touches generated OpenAPI/MCP doc artifacts. Mitigation: regen and re-verify is part of the acceptance checks.
- **Implementation order vs Item 2.** If this change lands before Item 2 and the implementation tranche edits `listStreams.summary`, the summary text MUST NOT reference `connection_id` or `display_name` (those are Item 2's). The summary edit lands as a `/v1/schema` direction-and-filter-capability hint; identity additions are Item 2's responsibility.
