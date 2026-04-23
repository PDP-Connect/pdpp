# Open question — record-query bracket syntax under Express 5's default parser

**Status:** open question; no spec change recommended here
**Raised:** 2026-04-22 during the W6 Fastify migration tranche
**Scope:** reference-implementation transport layer only; PDPP spec text is not affected. Historical context: the question was raised during the W6 Fastify migration when Express 5's default query parser threatened to flatten PDPP's nested bracket shape. The migration landed on a native Fastify transport that pins a `qs`-backed nested parser directly, so "Express 5" is no longer live code — but the underlying spec question (is the nested bracket shape the right long-term wire contract?) is unchanged and still worth a real review.

## Summary

Express 5 changed the default HTTP query-parser from `qs` (extended) to a
WHATWG-compatible `simple` parser. Under `simple`, a URL like

```
/v1/streams/top_artists/records?filter[source_updated_at][gte]=2026-01-01T00:00:00Z
```

is parsed as the flat object

```js
{ "filter[source_updated_at][gte]": "2026-01-01T00:00:00Z" }
```

instead of the previous Express 4 / PDPP-spec-shaped

```js
{ filter: { source_updated_at: { gte: "2026-01-01T00:00:00Z" } } }
```

That shape mismatch breaks the reference implementation's record-query path
because the spec and the manifests both assume the nested object.

PDPP Core §8 currently writes the wire contract in terms of the nested
bracket shape (see `spec-core.md` §8 "List records" — query parameters
`filter[{field}]`, `filter[{field}][gte]`, `expand[]`, `expand_limit[{relation}]`).

## Why Express 5 changed the default

Express's motivation was defensible:

- The `qs` parser with default options allows arbitrarily-deep nesting
  (`a[b][c][d][e]...`), which opens a DoS surface on large payloads.
- `qs` treats duplicate keys in ways that differ from the URL standard and
  from other HTTP stacks, which has been a recurring source of subtle
  interop bugs.
- `simple` matches Node's built-in `URLSearchParams` and the fetch ecosystem.

So Express 5's change isn't arbitrary — it's a security/consistency tightening.

## Current stance in this tranche

The reference implementation now runs on a native Fastify transport
(`reference-implementation/server/transport.js`) that parses query strings
using `qs` directly, bypassing Fastify's default `simple` parser. Depth is
bounded to 8 and array entries to 64 so the `qs` DoS surface that worried
Express 5 stays closed at the reference.

This is a **stop-gap**, not a recommendation. It keeps the implementation
wire-compatible with the spec without reopening the spec text during a
bounded migration tranche.

## Options the reviewer should consider (not deciding here)

Any of these would be a real proposal and should go through the normal spec
revision process, not be made silently during a Fastify migration:

1. **Keep the nested shape; keep the `extended` parser.** What we're doing
   today. Simple to ship. Accepts the DoS/pollution surface `qs` brings along;
   tight schema validation via `@pdpp/reference-contract` mitigates but does
   not eliminate it.

2. **Keep the nested shape; write a scoped parser.** Implement a small,
   bounded parser in the reference that only accepts `filter[field]=...`,
   `filter[field][op]=...`, `expand[]=...`, `expand_limit[rel]=...`. Reject
   deeper nesting and unexpected shapes with `400 invalid_request`. This
   keeps the spec wire shape, closes the DoS surface, and works identically
   under both Express 4, Express 5, and Fastify. Likely the best long-term
   answer but requires a small design pass and tests.

3. **Change the spec wire shape.** Move to a non-bracket convention like
   `filter=source_updated_at[gte]:2026-01-01T00:00:00Z` or
   `q=filter.source_updated_at.gte=2026-01-01T00:00:00Z`. This aligns with
   Express 5's simple parser for free but is a breaking change for any
   consumer already written against the bracket shape. Biggest blast radius.

4. **Move filter shape into a request body.** `POST /v1/streams/{stream}/records:search`
   with a JSON body. Removes the query-string problem entirely but changes
   the REST shape (cacheability, curl ergonomics, etc.).

## Recommendation

Take this question through a proper spec review after W6 lands. Until then
the reference keeps a `qs`-backed bounded nested parser and does not claim the current
parser choice is a first-class spec decision. Option 2 (scoped parser) is my
prior for when the review happens, because it preserves the spec's ergonomic
wire shape while closing Express's real concern.

## Cross-references

- `reference-implementation/server/transport.js` — native Fastify transport.
  Its `buildFastify()` configures `routerOptions.querystringParser` to call
  `qs.parse(str, { depth: 8, arrayLimit: 64 })`, which is what preserves
  the PDPP nested bracket shape at the transport boundary.
- `spec-core.md` §8 — normative wire-shape description that this depends on.
- Express 5 migration notes:
  https://expressjs.com/en/guide/migrating-5.html#query-parser (historical
  context; Express is no longer a dependency of the reference after the W6
  Fastify migration described in `tasks.md` and `design.md`).
