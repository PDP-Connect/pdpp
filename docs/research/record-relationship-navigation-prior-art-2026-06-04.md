# Record relationship navigation — prior art

Date: 2026-06-04
Status: captured (informative; supports `openspec/changes/add-record-relationship-navigation/`)

## Why this note

The reference implementation already exposes a manifest-declared, grant-scoped,
one-hop `expand[]` contract on `GET /v1/streams/<s>/records[/{key}]` (see
`openspec/specs/reference-implementation-architecture/spec.md`, "Public record
expansion" requirements; implementation in
`reference-implementation/server/record-expand-helpers.js` and the SQLite/Postgres
record backends; archived design under
`openspec/changes/archive/2026-04-24-enable-safe-parent-child-expand/`).

What the reference does **not** yet do:

1. No first-party connector manifest declares a `relationships[]` entry or a
   `query.expand[]` capability, so the contract has zero live coverage.
2. The operator console `/dashboard/records/<connection>/<stream>/<recordKey>`
   page fetches a single record and prints its JSON envelope; foreign-looking
   ids are unlinked text.
3. There is no protocol or UI guidance for broken/unreachable relationship
   targets (target stream not in grant, target stream not in current manifest,
   target record missing on the destination side).

This note collects the prior art used to design that work without re-deriving
it. The OpenSpec change `add-record-relationship-navigation` cites this file
rather than restating the comparison.

## Systems inspected

Each entry quotes only what the change proposal actually relies on. Full
references are at the bottom.

### Stripe — expandable fields

- Nested object fields are returned as **ids by default**; clients opt in by
  passing repeated `expand[]=<path>` query parameters.
  ([Stripe Docs — Expanding responses](https://docs.stripe.com/expand))
- Expansion is **manifest-declared**: an object's API reference page lists
  exactly which fields are expandable. There is no foreign-key heuristic; an
  unexpandable id stays a string id.
- Expansion supports **dotted paths** (`invoice.subscription`) up to a small,
  documented depth (Stripe caps at 3; third-party API design write-ups treat
  this as the canonical "shallow graph" tradeoff).
- On list endpoints, paths are rooted at the wrapper: `data.source.invoice`.
- Implications for PDPP:
  - The ID-default / expansion-opt-in shape matches PDPP's `expand[]` already.
  - Stripe ships its expansion graph in the API reference. PDPP ships its
    expansion graph in the **manifest**, which is the same idea applied to a
    federated polyfill ecosystem.
  - PDPP intentionally caps depth at **one hop today** (`design.md` of the
    2026-04-24 archive). Stripe's depth-3 is a useful North Star but is not
    needed to unblock console navigation.

### JSON:API — `relationships`, `include`, sparse fieldsets

- A resource has `attributes` and a sibling `relationships` member. Each
  relationship contains a typed **resource identifier object** (`type` + `id`),
  not a full record. ([JSON:API v1.1](https://jsonapi.org/format/))
- Clients sideload by passing `?include=author,comments.author`; the server
  returns the related records in a top-level `included` array. **Full
  linkage**: every record in `included` must be reachable through a relationship
  chain from primary data.
- Sparse fieldsets (`fields[TYPE]=…`) compose with `include`; relationships
  themselves are fields and follow the same projection rules.
- `self` links must preserve every query parameter the client supplied so the
  document is refreshable.
- Implications for PDPP:
  - The "id-only resource identifier in the primary record + hydrated payload
    in a side channel" shape is the cleanest envelope for unread/unreadable
    related records. PDPP already does this implicitly: the parent record
    carries the foreign-key field value, the expanded payload lands under
    `expanded.<relation>`.
  - `include` with dot paths and the requirement that any intermediate hop be
    serialized too is the right precedent for any future multi-hop expansion;
    we explicitly defer it.
  - JSON:API treats unreachable targets by **omitting** them from `included`,
    not by emitting a typed error. PDPP should do the same for "target record
    missing" cases (the `null` / empty-list semantics in the existing spec).

### GraphQL Relay — Cursor Connections specification

- `XxxConnection` wraps `edges[]` and `pageInfo`. Each edge holds `node`
  (the related record) and `cursor` (opaque pagination token), plus edge-only
  fields (e.g., "friendship since" on a friend edge).
  ([Relay Cursor Connections](https://relay.dev/graphql/connections.htm))
- Pagination uses `first`/`after` (forward) or `last`/`before` (backward), with
  ordering required to be consistent across pagination direction.
- `pageInfo.hasNextPage`/`hasPreviousPage` separates "is there more" from "what
  comes next".
- Implications for PDPP:
  - PDPP's `expand_limit[<relation>]=N` + `has_more` on the expanded list
    object is the lightweight, cursorless equivalent. We do **not** need
    edges with their own attributes; that complexity belongs to graph
    products, not to a personal data resource server.
  - The discipline of "ordering is part of the contract" is worth importing:
    expanded has-many children should have a defined order (manifest cursor
    field or primary key) so the page is reproducible.

### PostgREST — Resource Embedding

- Embedded resources are inferred from **declared foreign keys** in the
  Postgres schema. When ambiguity exists (two FKs to the same table), the
  client must disambiguate with `!<fk-name>` hints; otherwise the server
  returns a `PGRST201` error rather than guessing.
  ([PostgREST docs — Resource Embedding](https://docs.postgrest.org/en/stable/references/api/resource_embedding.html))
- Reverse (one-to-many) embedding works by naming the foreign-key constraint
  in the embed path; many-to-many requires the join table's foreign keys to
  be part of its primary key.
- Implications for PDPP:
  - PostgREST validates the lesson: **never auto-detect relationships from
    column names**. Either the manifest declares the relationship or the
    server refuses the request. PDPP must hold that line — heuristics like
    "any field ending in `_id` is a link" are out of scope.
  - The disambiguation idiom maps to PDPP relation **names**: a record can
    have multiple manifest-declared relationships to the same target stream
    (e.g., a Slack `messages` stream could declare `channel` and
    `thread_root`, both pointing at `channels` / `messages`). The relation
    name in `expand[<name>]` is the disambiguator.

### Airtable / Notion — linked-record and relation property semantics

- Airtable linked-record fields are foreign-key references between tables in
  the same base, surfaced as typed cell values; lookups and rollups compose
  on top. Notion relations are page-ID pointers between databases, with a
  softer schema and weaker computed-field story.
  ([Airtable vs Notion summary](https://www.whalesync.com/blog/airtable-vs-notion-the-ultimate-guide))
- Both products treat **navigability** as a first-class UI affordance: a cell
  value renders as a clickable chip that opens the related record.
- Implications for PDPP:
  - The console UI affordance — render a relationship value as a navigable
    chip rather than a raw id — is a reasonable, low-cost baseline. We do
    not need Airtable's rollup/lookup behavior to ship navigation.
  - The "page-ID across databases" model is exactly the cross-stream
    pointer model PDPP needs. The `record_key` plays the role of the
    page-ID.

## Key-field note — what the foreign key actually is

The reference's parent→child join filters the **child** stream's declared
`foreign_key` against the current page of **parent** record keys
(`WHERE child.<foreign_key> IN (…parent keys…)`; see
`reference-implementation/server/record-expand-helpers.js`, the two backend
hydration paths, and the durable-spec scenario "Expansion pushes child-stream
narrowing into SQL"). Three facts follow, and the design vocabulary
(`target_stream`, `child_parent_key_field`) encodes them:

- The `foreign_key` is a field **on the child record**, not the parent.
- Its value is the **parent's** record key, not the child's.
- The child's own record key is the child stream's `primary_key`, which is
  unrelated to the foreign-key field in general. For GitHub `issues`, the
  record key is `id`; `repository_id` holds the parent repository's key.

The prior-art systems below mostly hide this asymmetry behind bidirectional
linked-cell UIs (Airtable/Notion) or symmetric `include` graphs (JSON:API).
PDPP's contract is deliberately one-directional at the server, so the
synthesis must keep parent→child and child→parent navigation distinct.

## Synthesis — design implications for PDPP

1. **Manifest declaration is the only source of truth.** Like Stripe and
   PostgREST, PDPP must refuse to expand a relationship the manifest did
   not advertise. Loose foreign-key heuristics are explicitly out of scope.
2. **One-hop is enough for v1.** Stripe ships depth-3, JSON:API ships
   arbitrary depth with intermediate linkage; PDPP can hold the line at
   one hop and still cover the dashboard-navigation use case. The
   2026-04-24 archive established this; this change inherits it.
3. **Forward-only (parent → child) for v1.** Reverse navigation
   (`messages.thread` from a `messages` record) is the obvious next slice,
   but JSON:API and Relay both show that reverse traversal needs explicit
   manifest declaration of the reverse edge, not a heuristic. We defer it
   under a documented escape hatch.
4. **Grant scope ≠ relationship visibility.** A connector manifest may
   advertise a relationship whose target stream the current grant does not
   include. JSON:API would respond with a 400 if the include path is
   undefined; PostgREST would 400 on ambiguity. PDPP already returns
   `insufficient_scope` for "target stream not granted". The console UI
   needs to know about that case **without making the request**, which
   means surfacing `expand_capabilities.usable=false` to the operator UI
   rather than blindly issuing an expand request.
5. **Broken or missing children are data absence, not errors.** Both
   JSON:API (`included` omission) and the existing PDPP spec (`null` for
   has_one, empty list for has_many) agree. The console should render the
   absence calmly: "no related <relation>" instead of an error toast.
6. **Navigability is two things, not one.** Airtable/Notion teach the
   difference between:
   - **Inline expansion** — the related record(s) appear in the parent
     payload (what `expand[]` already does); and
   - **Linkable identity** — even without expansion, an id-shaped value
     can be a hyperlink. The console UI for navigation should provide the
     second affordance by default (cheap, no extra request) and the first
     as an opt-in (server cost, paid when the operator actually opens the
     record detail). **Direction matters, and PDPP's join is asymmetric**
     (see the key-field note below). For a declared parent→child has_many
     relation, the foreign-key field lives on the *child* and holds the
     *parent's* key. So:
     - From a **parent** record, the navigable target is the *filtered
       child list* (`<child>?filter[<fk>]=<parent_key>`), not a single
       child detail page — the parent key is not a child record key.
     - From a **child** record, the foreign-key value links *back* to the
       *parent's* detail page (`<parent>/<child.fk>`), because that value
       is the parent's record key.
     Airtable/Notion hide this asymmetry behind a bidirectional linked-cell
     UI; PDPP exposes it, so the console must build each direction
     correctly rather than treating "a foreign-key value links to the
     related record" as a single symmetric rule.
7. **Discoverability comes through stream metadata.** PDPP already
   exposes `expand_capabilities` on `GET /v1/streams/<s>`. That's the
   discovery surface — the dashboard reads it and renders relationship
   chips for declared relations whose `usable` is true, dims (or hides)
   chips whose `usable` is false with the manifest-supplied `reason`,
   and never invents links from raw payload fields.

## What this change does **not** import from prior art

- **Cursor-based opaque pagination on expanded children.** `expand_limit`
  + `has_more` is enough for the navigation slice.
- **Edge-typed metadata (Relay edges with their own attributes).** Not
  needed; the parent record already carries any per-link metadata in its
  payload.
- **Multi-hop / dotted expansion (Stripe / JSON:API include paths).**
  Held until reverse expansion is also designed.
- **Auto-detected foreign keys (PostgREST default).** Explicitly rejected
  for PDPP — manifests are the contract.

## Sources

- Stripe — Expanding responses overview. <https://docs.stripe.com/expand>
- Stripe — Expand use cases. <https://docs.stripe.com/expand/use-cases>
- JSON:API v1.1 specification. <https://jsonapi.org/format/>
- GraphQL — Pagination guide (Connections). <https://graphql.org/learn/pagination/>
- Relay — GraphQL Cursor Connections Specification. <https://relay.dev/graphql/connections.htm>
- PostgREST — Resource Embedding (stable). <https://docs.postgrest.org/en/stable/references/api/resource_embedding.html>
- Whalesync — Airtable vs Notion field-model comparison. <https://www.whalesync.com/blog/airtable-vs-notion-the-ultimate-guide>

Related local artifacts (cross-link, do not duplicate):

- `openspec/specs/reference-implementation-architecture/spec.md` — current
  expand requirements.
- `openspec/changes/archive/2026-04-24-enable-safe-parent-child-expand/` —
  baseline contract.
- `openspec/changes/archive/2026-05-28-add-postgres-expand-hydration/` —
  Postgres parity for the same contract.
- `openspec/changes/archive/2026-05-28-expand-first-party-parent-child-relations/` —
  earlier (deferred) attempt at backfilling first-party manifests.
- `design-notes/prior-art/slvp-reference-implementation-prior-art-2026-05-27.md`
  — adjacent prior-art note covering retrieval semantics.
