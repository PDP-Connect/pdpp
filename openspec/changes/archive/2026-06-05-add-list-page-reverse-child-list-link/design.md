# Design — add-list-page-reverse-child-list-link

## Context

Reverse parent → children navigation (parent → filtered child list, from a
child-declared `has_one`) is shipped on the record **detail** page and pinned by
the durable requirement "Operator console SHALL render a reverse
parent-to-filtered-child-list link from a child-declared `has_one`"
(`add-reverse-record-relationship-links`, commit `e85b068a`). That requirement is
explicitly scoped to a "**parent** record's detail page."

The child → parent direction, by contrast, already renders on **both** the record
list page and the detail page — its durable requirement names both surfaces, and
the list page draws per-cell child → parent links from
`childHasOneBackLinkForField` (commits `45671760`, `c2243fdf`). So today:

| Direction | Detail page | List page |
|---|---|---|
| child → parent (belongs-to) | link | link (per cell) |
| parent → children (reverse, from child `has_one`) | link | **none** |

This change closes the one asymmetric cell: a per-**row** reverse link on the
parent **list** page, so an operator scanning a list of accounts can reach any
account's transactions without first opening that account's detail page.

## Goals

1. On the parent list page, render one reverse link per `(parent row, child stream
   declaring a `has_one` back to the parent stream)`, targeting the child stream's
   filtered list `/dashboard/records/<conn>/<child>?filter[<fk>]=<rowKey>`.
2. Reuse the detail page's link semantics and encoding verbatim — no second copy of
   the reverse-link rule.
3. Add zero per-row server work: the manifest is already loaded once per list page;
   each row substitutes its own key as the filter value.
4. Preserve every constraint the detail-page rule already enforces (manifest-only,
   no heuristics, filtered list not detail URL, no inline child load, `has_many`
   ignored, dual-namespace manifest resolution, dedup against forward `has_many`).

## Non-goals

- **A new query grammar, endpoint, manifest field, or `expand_capabilities`
  entry.** The reverse link reuses the existing `filter[<field>]=<value>` list
  query; `GET /v1/streams/<child>/records?expand=<reverse>` stays `invalid_expand`.
- **Server-side reverse / belongs-to expansion.** Out of scope, exactly as in the
  detail-page change. Deferred behind its own proposal.
- **An inline child preview or count on the parent row.** A bounded inline preview
  is a defensible later enhancement (the detail-page design left the same door
  open); this change ships only the link, the lean slice.
- **Per-row metadata reads.** The links are drawn from the connector manifest the
  list page already loads. No additional fetch, no child scan.

## Decision

### D1. Page-level child-stream set, per-row href

The reverse link rule depends on two inputs: (a) which child streams declare a
`has_one` back to the displayed parent stream — constant for the whole list page,
since the displayed stream is the same for every row; and (b) each row's own record
key — the filter value. So the console SHALL:

1. Compute the set of `(child stream, foreign_key)` reverse edges **once per page**
   from the already-loaded connector manifest (the new pure helper
   `reverseChildListEdgesFromManifest`), and
2. For each parent row, build the filtered-child-list links by reusing the existing
   `reverseChildListLinksFromManifest(connectorStreams, { parentStream, parentRecordKey: row.id })`,
   which already produces the correct per-edge `filter[<fk>]=<rowKey>` hrefs with
   identical encoding to the detail page.

Reusing `reverseChildListLinksFromManifest` per row keeps the href construction,
percent-encoding, `has_many` exclusion, and dedup behavior in one place. The new
page-level helper exists only to answer "does this stream have any reverse child
edges at all?" cheaply, so a list page for a stream with no children skips the
per-row work entirely.

### D2. Bounded by construction; no inline collection, no N+1

The list page already issues exactly one `listConnectorManifests()` read and one
`queryRecords()` page read (plus the parent-metadata reads the forward child →
parent path already makes). The reverse links add **no** new read: the manifest is
already in `connectorManifest.streams`, and the per-row href is pure string
construction over each row's `id` (the parent record key) — the same value the row
already renders as its `id` cell. There is no per-row fetch, no child-stream scan,
and no inline child load. This holds the guardrail against table scans on the hot
list page.

### D3. Reuse detail-page semantics; dedup with forward `has_many`

The per-row reverse links pass the same `alreadyLinked` dedup-key set the detail
page builds: when a parent stream's forward `has_many` `expand_capabilities` entry
and a child-declared `has_one` resolve to the same `(child stream, filter field)`,
the row renders one link, not two. In the first-party set this overlap does not
occur (the `expand`-enabled parents — github `user`, gmail/slack `messages` — are
not the belongs-to parents), but the dedup is wired so a future manifest declaring
both directions does not double-render. On the **list** page the parent's forward
`expand_capabilities` are not currently fetched (the list page fetches *parent*
metadata for the displayed child stream, not the displayed stream's own
capabilities), so the dedup set is empty in practice today; the reverse helper still
self-dedups a child stream that declares the same `has_one` twice. Wiring the
forward-`has_many` dedup set on the list page is left as a no-op-today consistency
follow-up, not required for correctness in the first-party set.

### D4. UI form: a compact per-row "children" affordance

Each parent row renders its reverse links as a small, clearly-labeled set of
links distinct from the row's own record-detail link and from the per-cell
child → parent links. The label names the child stream and its `has_many`
direction (e.g. `transactions →`), matching the detail page's reverse-link label
form. The links live in their own cell/region so they do not collide with the
existing "click the row to open the record" affordance. No new column header
semantics are introduced for the data columns; the reverse links are row
navigation chrome, not a data column.

### D5. Canonicalization reuses the existing resolver

The list page already resolves the connector manifest via
`findManifestForConnectorId` (matching both URL-form `connector_id` and short
`connector_key`). The reverse links reuse that same resolved manifest, so they
appear for live connections exactly as the forward child → parent cell links and
the detail-page reverse links do. A connection that resolves to no manifest renders
no reverse links (it renders no forward cell links today either).

## Alternatives considered

### A1. Leave the list page as detail-only (status quo)

Pro: zero change; the detail page already serves the reverse link.
Con: the asymmetry is real and operator-visible — child → parent renders on both
surfaces, parent → children only on detail. Scanning a list of parents to reach
each one's children requires an extra click per parent. The slice is small and
fully data-supported, so closing the asymmetry is worth the focused change.

### A2. Server-side reverse expansion so the list page lights up via `expand[]`

Pro: a forward-style API path.
Con: the foreign key is on the child, not the parent, so the engine cannot serve
the relation forward without a reverse-lookup contract — a large server change, the
same one the detail-page change rejected (its A1). The bounded filtered-list link
already gives the operator the children with zero server change. Rejected;
deferred behind its own proposal.

### A3. Inline a bounded child preview/count per parent row

Pro: shows whether children exist without a click.
Con: a per-row capped child query is an N-read on the hot list page (50 rows ×
child streams), the exact cost this change avoids. The detail-page design left a
bounded inline preview as a possible later enhancement; doing it per list row is a
heavier, separately-justified change. Rejected for this slice.

### A4. Add reverse `has_many` relationships to the parent manifests

Pro: the forward `has_many` console + server paths would cover it with no new rule.
Con: it requires editing ~13 connector manifests and making each child's parent-key
field a required top-level property to satisfy manifest validation — a broad
manifest + validation change, the opposite of lean. The child already declares the
edge; reading it in reverse needs no manifest change. Rejected, same as the
detail-page change's A3.

## Acceptance checks

- `openspec validate add-list-page-reverse-child-list-link --strict` passes.
- `openspec validate --all --strict` passes (no regression).
- New unit tests in `relationships.test.ts` prove: a parent list row yields one
  `…/<child>?filter[<fk>]=<rowKey>` link per child-declared `has_one`; distinct
  rows produce distinct filter values; a stream with no reverse child edges yields
  none; the page-level edge helper returns the correct child-stream set and is empty
  for a childless or missing stream; `has_many` child declarations produce no
  reverse link; percent-encoding matches the detail page.
- `node --test --import tsx apps/console/src/app/dashboard/records/lib/relationships.test.ts`
  and `pnpm --filter pdpp-console run types:check` are green.
- `git diff --check` reports no whitespace errors.
