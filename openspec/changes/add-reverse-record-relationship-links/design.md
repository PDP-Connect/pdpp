# Design — add-reverse-record-relationship-links

## Context

State at HEAD `8bcd861a` (branch `workstream/ri-relationship-reverse-links-openspec-v1`):

- **Forward (child → parent) navigation is shipped and green.** A child record
  links to its declared parent from two manifest sources:
  - the parent stream's `expand_capabilities` (`findParentBackLink`), defined by
    the archived `add-record-relationship-navigation`; and
  - the displayed child stream's own declared `has_one` relationship
    (`childHasOneBackLinksFromManifest`), sanctioned by the active
    `add-child-manifest-relationship-backlinks`.
  Both are unit-tested (20/20 in `relationships.test.ts`) and manifest-grounded.
- **The reverse direction (parent → its children) is unauthorized.** The only
  parent → child console path is `buildRelatedLinks`, which reads the parent
  stream's `expand_capabilities` `has_many` entries and renders a link to the
  **filtered child list** (`filter[<child_parent_key_field>]=<parent key>`). That
  path only lights up for streams that enable `query.expand[]` — `gmail.messages`,
  `github.user`, `slack.messages`. Every belongs-to edge (Chase, USAA, YNAB,
  ChatGPT, …) is declared on the **child** as a `has_one`, so the parent stream
  emits no `expand_capabilities` and `buildRelatedLinks` produces nothing.
- **The owner example.** Chase `accounts` declares no `query.expand[]`. Its child
  `transactions` declares `relationships[] = { name: "account", stream:
  "accounts", cardinality: "has_one", foreign_key: "account_id" }`. Standing on an
  `accounts/<accountKey>` detail page, there is no path to that account's
  transactions, even though every transaction carries `account_id = <accountKey>`.
- **The bounded receiving end already exists.** The stream list page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` parses
  `filter[<field>]=<value>` query params (`readExactFilters`, `FILTER_PARAM_RE`)
  and passes them to `queryRecords`, which encodes them on the wire as
  `filter[<field>]=<value>` and the resource server applies them **server-side**
  (`apps/console/src/app/dashboard/lib/rs-client.ts` `queryRecords`). This is the
  same bounded, paginated list surface the forward `has_many` link already
  targets. Nothing new is needed on the receiving side.
- **The durable spec already houses the bounded form.** `reference-implementation-architecture`
  defines "Reader navigates parent to a filtered child list using the child's
  parent-key field" (`filter[<fk>]=<parentKey>`) and the console requirement
  "Usable `has_many` relation renders as a link to the filtered child list". The
  reverse affordance is the inverse of these, sourced from a child-declared
  `has_one` rather than a parent-declared `has_many`.

The shipped reverse gap was reported in
`tmp/workstreams/ri-relationships-bidir-navigation-v2-report.md`, which drafted
the exact requirement language this change formalizes and deliberately stopped
short of implementing it because no active change authorized it.

## Goals

1. Authorize a single, bounded, manifest-grounded reverse navigation affordance:
   parent detail page → link to the filtered child list, for each child stream
   that declares a `has_one` targeting the displayed parent.
2. Reuse the existing `filter[<fk>]=<parentKey>` list query that the reference
   already supports server-side — no new query grammar, no inline child load.
3. Keep the server contract untouched: no reverse `expand`, no new
   `expand_capabilities`, no new endpoint, no manifest change.
4. Preserve the manifest-only / no-heuristics discipline and connector-agnosticism
   the forward changes established.

## Non-goals

- **Server-side reverse / belongs-to expansion.** `GET /v1/streams/<child>/records?expand=<reverse>`
  stays `invalid_expand`. The companion change's "Child-declared back-link does
  not imply server-side reverse expansion" scenario stays in force; this change
  restates it for the parent-side direction.
- **An in-page child collection on the parent.** The parent detail page does not
  fetch or render the children inline. It renders one link per related child
  stream to that stream's bounded, paginated list view. (A future bounded
  *preview* with a deep link is an acceptable later enhancement — see prior art —
  but is explicitly out of scope here.)
- **A new `expand_capabilities` entry for the parent, or any manifest change.**
  The reverse edge is read from the child's already-declared `has_one`; no
  reverse relation is added to any manifest.
- **`has_many` child declarations.** Only a child-declared `has_one` (a
  belongs-to whose `foreign_key` holds the parent's key) produces a reverse link.
- **Multi-hop, cross-connector, or edge-typed navigation.** Out of scope,
  consistent with the forward changes.

## Decision

### D1. Parent → filtered child list from a child-declared `has_one`

For a displayed **parent** record on `/dashboard/records/<conn>/<parent>/<parentKey>`,
the console SHALL, for each child stream in the same connector manifest whose own
`relationships[]` declares a `has_one` with `stream == <parent>` and a non-empty
`foreign_key <fk>`, render a navigable link to the child stream's record-list
page filtered by that parent key:

```
/dashboard/records/<conn>/<child>?filter[<fk>]=<parentKey>
```

The link target is the **bounded, filterable child list** — the same page and the
same `filter[<field>]=<value>` query that the forward `has_many` navigation
(`buildRelatedLinks`) already targets and that the resource server applies
server-side. The parent key is used only as the filter value; it is never treated
as a child record key, so no `/dashboard/records/<conn>/<child>/<parentKey>`
detail URL is constructed.

This is the inversion of `childHasOneBackLinksFromManifest`: that helper, given a
child record, links **up** to the parent detail page; this rule, given a parent
record, links **down** to the filtered child list. Both read the identical
child-declared `has_one` manifest entry; they differ only in direction and in
list-vs-detail target.

### D2. Bounded by construction; no inline collection

The affordance loads no child records into the parent page. It emits one href per
related child stream; the children are fetched only when the operator follows the
link, by the existing paginated list page (`PAGE_SIZE = 50`, server-side
`filter`, cursor pager). This matches the cross-industry consensus (Salesforce
"View All", Django filtered changelist, Stripe scoped lists, ActiveAdmin
`belongs_to` index; see `design-notes/prior-art-filtered-child-list.md`) that a
parent surfaces its children via a *link to a filtered list*, never an unbounded
inline load.

### D3. Console-only; manifest-grounded; no reverse expand

The reference server is unchanged. The console issues no `expand[]` request to
draw the link — the manifest already declares the `has_one`, and the parent key
is the displayed record's own key. The reverse link uses the existing
`filter[<field>]=<value>` list query, which is not `expand` and introduces no new
grammar. `GET /v1/streams/<child>/records?expand=<reverse>` continues to fail
`invalid_expand`. The no-heuristics line holds: only declared `relationships[]`
produce links; a parent field that merely looks like a key produces nothing.

### D4. Canonicalization is required

The parent detail page already resolves the connector manifest via
`findManifestForConnectorId` (matching both URL-form `connector_id` and short
`connector_key`). The reverse rule reuses that resolver to enumerate sibling
child streams in the same manifest, so reverse links resolve for live connections
exactly as the forward links do. A connection that resolves to no manifest
renders no reverse links (it renders no forward links today either).

### D5. Chase is the proving scenario; the rule is generic

The requirement is connector-agnostic. Chase `accounts -> transactions[]` (via the
child-declared `transactions.account_id -> accounts` `has_one`) is pinned because
it is the owner's reported example and the simplest end-to-end case (single
`has_one`, scalar string `foreign_key`). The other belongs-to connectors ride the
same rule with no per-connector spec text, consistent with the forward changes'
rejection of per-connector backfill. A connector whose child relationship is not a
single-scalar `has_one` is a follow-up rule extension, not covered here.

### D6. Dedup with the forward `has_many` parent path

When a parent stream both declares a `has_many` `expand_capabilities` entry to a
child stream **and** that child declares a `has_one` back to the parent, the two
rules resolve to the same `(child stream, filter field, parent key)` filtered
list. The console SHALL render a single link for that child stream, not two. (In
the first-party set this overlap does not occur — the `expand`-enabled parents are
not the belongs-to parents — but the rule is stated so a future manifest that
declares both directions does not double-render.)

## Alternatives considered

### A1. Server-side reverse expansion (`accounts?expand=transactions`)

Pro: a single forward-style API path; `buildRelatedLinks` would light up.
Con: the foreign key is on the child, not the parent, so the engine cannot serve
the relation forward without a reverse-lookup contract — a large server change
(the archived audit's core finding), not a console slice. The bounded filtered
list already gives the operator the children with zero server change. Rejected for
this change; left as possible future work behind its own proposal.

### A2. Inline the children on the parent detail page

Pro: one click fewer.
Con: an unbounded inline child load is the exact correctness/perf bug every mature
system gates against (Django un-paginated inlines, Hasura nested `order_by`; see
prior art). A bounded inline preview is defensible but adds a capped server query,
preview UI, and "view all" link for marginal benefit. The lean SLVP slice is the
link alone. Deferred, not rejected — the requirement permits a later bounded
preview as an additive enhancement.

### A3. Declare reverse `has_many` relationships on the parent manifests

Pro: the forward `has_many` console + server paths would cover it with no new
rule.
Con: it requires editing ~13 connector manifests (and, per the durable spec's
GitHub note, making each child's parent-key field a required top-level property to
satisfy manifest validation) — a broad manifest + validation change, the opposite
of lean. The child already declares the edge; reading it in reverse needs no
manifest churn. Rejected for this change.

### A4. Fold this into `add-child-manifest-relationship-backlinks`

Pro: one artifact owns child↔parent navigation.
Con: that change is explicitly scoped to the child → parent direction and lists
reverse parent → child as a non-goal; it is documentation-only over already-shipped
code, whereas this authorizes a not-yet-built affordance. A separate additive
change keeps the two decisions auditable and lets the reverse implementation lane
land independently. Rejected.

## Acceptance checks

The change is acceptable when:

1. `openspec validate add-reverse-record-relationship-links --strict` passes.
2. `openspec validate --all --strict` passes (no regression against the baseline).
3. The added requirement is internally consistent with the durable spec's
   existing forward filtered-child-list contract (same `filter[<fk>]=<parentKey>`
   form, same bounded list target) and with the companion change's reverse-expand
   prohibition.
4. No code, manifest, server, or contract file changes in this change
   (proposal/design/tasks/spec-delta only). `git diff --check` clean.

## Residual risks

- **Implementation deferred.** This lane delivers the authorized contract, not the
  console code. The next lane implements one pure helper (invert child-declared
  `has_one` edges into parent-side filtered-list links) plus parent-detail-page
  wiring and focused tests. Until then the reverse direction remains non-navigable
  on the deployed console; the contract simply makes the work authorized.
- **Dead-link tolerance.** If a parent has no matching children (e.g. the child
  stream is ungranted or empty), the filtered list page renders its calm "No
  records." state — the same bounded-empty behavior the forward `has_many` link
  already accepts. No crash, no error toast.
- **Spec fold obligation.** This change and `add-child-manifest-relationship-backlinks`
  both modify `reference-implementation-architecture`. At archive time the
  child → parent and parent → child requirements SHALL be folded into a coherent
  durable contract naming both directions and both manifest sources, so the
  durable spec never carries them as two disconnected affordances.
- **Single-scalar assumption.** The rule assumes a child-declared `has_one` with a
  single scalar `foreign_key`. A composite or array foreign key is a follow-up
  rule extension, not served here.
