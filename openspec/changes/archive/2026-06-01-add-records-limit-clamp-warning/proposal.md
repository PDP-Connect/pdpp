## Why

`spec-core.md` §8 ("List records") fixes the records-list page contract: `limit`
defaults to 25 and is capped at 100. The `@pdpp/reference-contract`
`ListRecordsQuerySchema` already declares `limit: { maximum: 100 }`. But two
reference surfaces were inconsistent with that contract in a way that surprises
agent clients:

1. **REST silently clamps.** When a caller sends `limit=500`, the runtime clamps
   to 100 (`records.js`, `postgres-records.js`) and returns the bounded page with
   no signal that the cap was applied. `has_more`/`next_cursor` tell the agent
   more records exist, but nothing tells it the page size it asked for was reduced
   — so an agent can keep requesting a 500-record page every round and reason
   against a page that never existed. This is exactly the kind of silent
   token-efficiency surprise the agent-facing read contract is meant to avoid.

2. **MCP advertised a wrong cap.** The MCP `query_records` tool input schema
   advertised `limit` max **1000**, contradicting the normative max of 100. An
   agent reading the tool schema believed 1000 was valid; the RS then silently
   clamped it. This also violates the tool's own stated rule — "MCP does not
   silently drop a parameter the RS would reject."

This change makes both surfaces honest to the already-normative `max 100`
contract without breaking existing REST callers.

## What Changes

- **REST/RS (additive, non-breaking).** The records-list path keeps clamping an
  over-max `limit` to 100 — a lenient, non-breaking choice — but the reduction is
  no longer silent. When `limit > 100`, the response carries a structured
  `limit_clamped` entry in the existing canonical `meta.warnings[]` envelope,
  naming the requested limit and the effective maximum. A `limit` within the cap
  (including exactly 100) emits no warning. A non-positive/unparseable `limit`
  falls back to the default 25 and is not reported as a clamp (there is nothing to
  honestly report). This reuses the established `meta.warnings[]` channel and adds
  one new canonical warning code (`limit_clamped`); no new envelope field shape is
  introduced.
- **MCP (conformance fix).** The MCP `query_records` `limit` input schema is
  tightened from `max(1000)` to `max(100)` to match `spec-core` §8 and the public
  contract. An over-max `limit` is now rejected at MCP input validation before it
  reaches the RS, so the page size an agent requests through the tool is the page
  size it receives. The tool description is updated to teach the cap and to point
  at the REST `limit_clamped` warning for direct REST callers.
- **Shared primitive.** The SQLite and Postgres record paths previously each held
  their own inline `limit` clamp with duplicated `25`/`100` magic numbers. Both
  now use one shared `clampRecordsPageLimit` helper (and named
  `RECORDS_DEFAULT_PAGE_LIMIT` / `RECORDS_MAX_PAGE_LIMIT` constants) in the module
  both already import, so the runtime, the warning message, and the tests have one
  source of truth.
- **Tests.** Enforceable acceptance tests prove: the shared clamp helper's
  default/in-range/over-max/invalid behavior; that an end-to-end `limit=500`
  records read returns ≤100 rows AND a `limit_clamped` warning; that an in-range
  limit and the default page emit no warning; that multi-connection fan-in
  deduplicates the warning to one entry; and that the MCP tool rejects an over-max
  `limit` at input validation while advertising the inclusive `maximum: 100`.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: the "Public read warnings SHALL be
  structured and closed over known non-fatal outcomes" requirement gains
  `limit_clamped` as a known non-fatal outcome; the "MCP read tools SHALL mirror
  the canonical public read contract" requirement gains the records-list `limit`
  cap as an argument the MCP surface validates rather than forwards-then-clamps.

## Impact

- **Additive on REST.** Existing callers that send `limit ≤ 100` (or omit it) see
  no change. Callers that send `limit > 100` still receive a valid bounded page;
  they additionally receive a `limit_clamped` warning in `meta.warnings[]`. No
  caller starts receiving a 400 it did not receive before. No record envelope,
  cursor, count, window, or connection-identity behavior changes.
- **Tightening on MCP only.** An MCP client that sent `limit > 100` previously
  received a silently clamped page; it now receives a typed input-validation
  error naming the cap. This aligns the MCP surface with the normative contract
  and the public OpenAPI, which already declared `maximum: 100`. The set of
  accepted values (1–100) is unchanged; only the previously-mis-advertised
  101–1000 range is now correctly rejected.
- No change to grant evaluation, disclosure, the deprecated
  `connector_instance_id` alias, search/aggregate limits, or `/_ref` timeline
  pagination.
