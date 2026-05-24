## 1. `listStreams` / `getStreamMetadata` summary honesty

- [ ] Update the `summary` string for `listStreams` (line ~1285 in `packages/reference-contract/src/public/index.ts`) so it explicitly says this endpoint returns stream-level totals only and directs the caller to `/v1/schema` first for field-level filter capabilities. Keep the change to the `summary` and the `description` (if any) — do not change `operationId`, path, parameters, or response shape. Identity additions on response items are owned by Item 2 (`expose-connection-identity-on-public-read`) and are NOT touched here.
- [ ] Update the `summary` string for `getStreamMetadata` (line ~1308) with the same direction-to-`/v1/schema` wording, scaled to a single stream.
- [ ] Add a contract-level test (or extend an existing one) that asserts both summary strings name `/v1/schema` so future drive-by edits cannot silently drop the hint.

## 2. Hybrid pagination unavailability hint + cookbook

- [ ] Verify the runtime path that builds `ProtectedResourceDiscoveryHintsSchema.hybrid_pagination_supported` (already declared at line ~477 in the contract and emitted from `reference-implementation/server/metadata.ts`) is wired to the same capability advertisement state used to decide whether hybrid is advertised at all. If not, fix the wiring before relying on the hint.
- [ ] Extend the `summary` of `searchRecordsHybrid` (operation registered around line ~1636) to name `pdpp_discovery_hints.hybrid_pagination_supported` and recommend lexical search as the cursor-pagination fallback when hybrid pagination is reported unavailable.
- [ ] Add a short note in `docs/agent-skills/pdpp-data-access/references/query-cookbook.md` near the existing pagination section stating that hybrid does not support `cursor` and that callers needing more than `limit` results SHOULD fall back to lexical search.
- [ ] Test: extend `reference-implementation/test/provider-metadata.test.js` to assert that whenever the hybrid retrieval capability is advertised, `pdpp_discovery_hints.hybrid_pagination_supported` is present and matches the live runtime capability flag. Assert it is omitted (not `false`-defaulted) when hybrid is not advertised, matching the existing pattern from `polish-reference-api-discovery-seams`.

## 3. `ListRecordsQuerySchema.filter` description

- [ ] Add or replace the JSON Schema `description` on the `filter` property in `ListRecordsQuerySchema` (line ~98 in `packages/reference-contract/src/public/index.ts`) so it reads: "Per-field filter map. Exact: `filter[field]=value`. Range: `filter[field][op]=value` where `op` is one of the declared `field_capabilities.range_filter.operators` from `GET /v1/schema`." Description only — no change to type, format, or validation.
- [ ] Add a contract test asserting the description string references `/v1/schema` and `field_capabilities` so drive-by edits do not silently drop the hint.

## 4. Contract regeneration

- [ ] Run `pnpm --filter @pdpp/reference-contract run check:generated`. If it fails because generated artifacts moved, regenerate per the package's `verify` script and commit the regenerated artifacts in the same commit as the contract edit.
- [ ] Run `pnpm --filter @pdpp/reference-contract run verify`.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `pnpm --dir reference-implementation exec node --test test/provider-metadata.test.js test/query-contract.test.js`.

## 5. Validation

- [ ] Run `openspec validate clarify-public-read-contract-llm-hints --strict`.
- [ ] Run `openspec validate --all --strict`.

## Out of scope (owned by Item 2)

- Adding `connection_id` / `display_name` to `listStreams` response items.
- Adding `connection_id` to lexical/semantic/hybrid search result items.
- Defining fan-in vs `ambiguous_connection` error semantics.
- Per-connection consent-card label requirement and `legacy`/`default_account` removal.
- `connector_instance_id` compatibility alias.

These are all owned by `openspec/changes/expose-connection-identity-on-public-read` (Item 2). This change MUST NOT duplicate them.
