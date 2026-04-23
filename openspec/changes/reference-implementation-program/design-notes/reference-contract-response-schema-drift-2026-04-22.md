# Open question — reference-contract response-schema drift vs live server payloads

**Status:** open question; surfaced during W6 full-manifest route attachment
**Raised:** 2026-04-22
**Scope:** `packages/reference-contract` response schemas and the actual
response bodies emitted by `reference-implementation/server/index.js`. No
PDPP spec text changed.

## Summary

When W6 attached contract-package route manifests directly to Fastify routes
via the `{ contract: 'opId' }` option, Fastify's `fast-json-stringify`
serializer started running response payloads through the declared response
schema. That surfaced drift between several manifest response schemas and
the actual server response shapes. Specifically:

- `refGetConnector` declares `streams` as `items: { type: 'string' }`, but
  the server returns `streams: [{ name, freshness }]`. Fastify silently
  truncates every item.
- `refListApprovals` (and `refGetConnector`) declares summaries without
  fields the server actually emits (`manifest_excerpt`, `recent_runs`,
  `grant_preview.connector_id` etc.), so those fields get stripped in
  transit.
- `getStreamMetadata` returns `{freshness, query, views, relationships}`
  under `additionalProperties: true`, but the inner shapes aren't fully
  described and some runs omit fields the ajv-based validator otherwise
  accepts loosely. When serialization is enforced, subtleties like
  ordered property emission and null-vs-absent fields matter.

## Current stance

The reference Fastify transport at
`reference-implementation/server/transport.js` attaches only the
**request-side** contract schemas to Fastify routes (`params`,
`querystring`, `headers`, `body`) and deliberately omits the response
schemas. That keeps the contract "registered directly on Fastify routes"
(the W6 acceptance criterion) while preventing the drift from silently
truncating live responses. `transport.js#buildRouteSchema` carries a
code-level comment pointing at this open question so future contributors
see the tradeoff in situ.

## Options

1. **Align every manifest response schema with the live server payload,
   then re-enable response-schema attachment.** Highest-fidelity answer.
   Requires walking each route's actual response shape (with all
   branches — success, 404, 403, etc.) and writing schemas that describe
   exactly what the server emits. The schemas today are looser on purpose
   because they were hand-authored ahead of full handler implementation.
2. **Make the manifests loose (`additionalProperties: true` at every
   level) so serialization is a no-op.** Faster but undoes the usefulness
   of having response schemas at all.
3. **Keep request-side attachment only (today's stance) and let a
   later tranche tighten the response surface deliberately.** The
   generated OpenAPI artifact still documents response shapes from the
   manifest — it's just not enforced at the transport.

## Recommendation

Take option 1 as a focused tranche. It pairs well with the deferred
browser-level smoke work because both are about making the contract
observable end-to-end. It was deliberately out of scope for W6 (the
Fastify migration) and is not claimed by W7 (the final truthfulness /
polish pass) either, so it remains legitimate deferred work.

## Cross-references

- `reference-implementation/server/transport.js` — `buildRouteSchema()`
  comment explaining the omission.
- `reference-implementation/test/fastify-transport.test.js` — asserts
  request-side schema attachment, not response-side.
- `packages/reference-contract/src/public/index.js` — public manifests.
- `packages/reference-contract/src/reference/index.js` — `/_ref` manifests.
