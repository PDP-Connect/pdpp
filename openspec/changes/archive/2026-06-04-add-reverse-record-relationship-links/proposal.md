## Why

Forward child → parent navigation is shipped and green: a Chase `transactions`
record links to its declared `accounts` parent via the child stream's own
manifest `has_one` relationship (`childHasOneBackLinksFromManifest`, sanctioned
by `add-child-manifest-relationship-backlinks`). The reverse direction is not.
Standing on a Chase `accounts` record, the operator has no path to that account's
transactions, because `accounts` declares no `query.expand[]` — so the server
emits no `expand_capabilities` for `accounts`, and the only parent → child
console path (`buildRelatedLinks` over `has_many` capabilities) produces nothing.

The owner expects relationships to be navigable in both directions where it is
safe. The safe form is already proven by the forward `has_many` path and is
supported end-to-end by the reference today: the console stream list page reads
`filter[<field>]=<value>` query params (`[connector]/[stream]/page.tsx`,
`readExactFilters`) and the resource server's list endpoint applies them
server-side (`queryRecords` → `GET /v1/streams/<child>/records?filter[<fk>]=<v>`).
The reverse affordance is the inverse of the forward `has_many` link: on a parent
detail page, render a link to the **filtered child list** for each child stream
that declares a `has_one` targeting the displayed parent, scoped by
`filter[<child.foreign_key>]=<parent record key>`. No child collection is loaded
into the parent page; no server-side reverse `expand` is introduced; the manifest
remains the source of truth. Mature admin/CRM surfaces (Salesforce "View All",
Django `?<fk>__id__exact=<pk>` changelist, Stripe scoped lists, ActiveAdmin
`belongs_to` index) converge on exactly this bounded link-to-filtered-list form;
see `design-notes/prior-art-filtered-child-list.md`.

This change authorizes that one bounded affordance so the existing forward
navigation gains a safe reverse direction without overbuilding.

## What Changes

- Add a normative operator-console requirement: on a **parent** record's detail
  page, for each child stream whose **own** manifest declares a `has_one`
  relationship targeting the displayed parent stream, the console SHALL render a
  navigable link to that child stream's record-**list** page filtered by
  `filter[<child.foreign_key>]=<parent record key>`. The relationship structure
  SHALL come from the child stream's declared `relationships[]` (a manifest
  declaration); the link target SHALL be the bounded, filterable child list,
  never an in-page load of the child collection and never a single
  child-record-detail URL built from the parent key.
- Constrain the affordance to preserve the no-heuristics discipline: only
  manifest-declared `has_one` child relationships whose related `stream` equals
  the displayed parent stream and which declare a non-empty `foreign_key` produce
  a reverse link; `has_many` child declarations and undeclared fields do not.
  Links are derived from declared manifest relationships only, never from payload
  field-name heuristics, and never connector-specific hard-coding.
- State explicitly that this is a **console-only** affordance that introduces no
  server-side reverse expansion: `GET /v1/streams/<child>/records?expand=<reverse>`
  continues to fail `invalid_expand`. The reverse link reuses the existing,
  already-supported `filter[<field>]=<value>` list query — no new query grammar,
  no new endpoint, no new manifest field, no new `expand_capabilities`.
- Require connector key/url canonicalization: the parent detail page resolves the
  connector manifest through the dual-namespace resolver (`findManifestForConnectorId`
  / `manifestMatchesConnectorId`, matching both the URL-form `connector_id` and
  the short `connector_key`), so the reverse links resolve for live connections,
  consistent with the forward path.
- Pin the owner's Chase `accounts -> transactions[]` example as the proving
  scenario. The rule is connector-agnostic; every connector whose child stream
  declares a `has_one` back to a parent (USAA, YNAB, and the others enumerated in
  the companion change) rides the same rule with no per-connector spec pin. No
  manifest changes — the child-side `has_one` relationships already exist as
  declared descriptive metadata.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture` — adds one operator-console
  requirement for parent → filtered-child-list reverse links derived from a
  child-declared `has_one` relationship, alongside the forward relationship
  requirements already in the durable spec and the child → parent back-link
  requirement introduced by `add-child-manifest-relationship-backlinks`. No
  server, contract, manifest, query-grammar, or grant behavior changes.

### Removed Capabilities

- None.

## Impact

- Affected operator console (implementation landed on `main`, commit `e85b068a`):
  the parent record detail page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx`
  (wires `reverseChildListLinksFromManifest`, resolves the manifest via
  `findManifestForConnectorId`, dedups via `reverseChildListDedupKey`) and the
  relationship helper module
  `apps/console/src/app/dashboard/records/lib/relationships.ts`
  (`reverseChildListLinksFromManifest`, sharing `filteredChildListHref` with the
  forward path). The receiving list page `[connector]/[stream]/page.tsx`
  (`readExactFilters` → server `filter[…]`) already existed and is unchanged.
- Affected manifest surface: none. The child-side `has_one` `relationships[]`
  entries (e.g. Chase `transactions -> accounts`) already exist as declared
  metadata and are read in the reverse direction without modification.
- Affected public surface: none. `GET /v1/streams/<s>` `expand_capabilities`,
  the `expand[]` grammar, the `filter[<field>]=<value>` list-query grammar, and
  the grant model are all unchanged. The reverse affordance issues no `expand[]`
  request and adds no new query parameter.
- No new dependencies, storage tables, blob semantics, search endpoints, query
  grammar, or owner-auth surfaces.
- No protocol semantics in `spec-*.md` change. PDPP Core remains a
  consent/disclosure protocol; this change documents reference-implementation
  operator-console behavior over manifest-declared relationships.
- Relationship to siblings: this change and `add-child-manifest-relationship-backlinks`
  modify the same capability with additive `## ADDED Requirements` deltas (child →
  parent back-links there; parent → filtered child list here). Archive order does
  not affect validation. At archive time the two relationship-navigation
  requirements SHALL be folded into the durable spec as a coherent contract that
  names both navigation directions and both manifest sources (parent
  `expand_capabilities` and child-declared `relationships[]`).

## Residual Risks

- **Owner-only live render check (was task 3.3) — satisfied live.** The
  deployed-console verification that a Chase `accounts` detail page renders a
  working filtered "transactions" list link is owner-gated (it needs an instance
  with Chase data). It is recorded here as a residual risk rather than an open task
  per `AGENTS.md`, and it is already satisfied by the live records/connections proof
  (`tmp/workstreams/ri-records-connections-live-proof-v2-report.md`, Warning 4): on
  deployed revision `9dc62b5868fc`, a Chase `accounts` record `1212486749` targets
  `transactions?filter[account_id]=1212486749` and
  `GET /v1/streams/transactions/records?connector_id=chase&filter[account_id]=1212486749`
  returns HTTP 200 with 3 selectively-filtered rows. The contract proof remains the
  unit tests in `relationships.test.ts`; the live check only confirms operator-visible
  rendering, which is bundled-manifest-derived and deploy-revision-independent.
- **Dead-link tolerance.** If a parent has no matching children (the child stream is
  ungranted or empty), the filtered list page renders its calm "No records." state —
  the same bounded-empty behavior the forward `has_many` link already accepts. No
  crash, no error toast.
- **Single-scalar `foreign_key` assumption.** The rule serves a child-declared
  `has_one` with a single scalar `foreign_key`. A composite or array foreign key is a
  follow-up rule extension, not served here.
