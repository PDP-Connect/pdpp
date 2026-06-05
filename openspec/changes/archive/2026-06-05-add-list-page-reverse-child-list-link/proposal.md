## Why

Reverse parent → children navigation is shipped on the record **detail** page: a
Chase `accounts` detail page renders a link to that account's filtered
`transactions` list, derived from the child stream's own declared `has_one`
(`reverseChildListLinksFromManifest`, authorized by
`add-reverse-record-relationship-links`, durable requirement "Operator console
SHALL render a reverse parent-to-filtered-child-list link from a child-declared
`has_one`"). That requirement is scoped to the parent record **detail** page only.

The record **list** page is asymmetric. The child → parent direction already
renders on **both** the list and detail pages (durable requirement "Operator
console SHALL render manifest-declared parent links on the child record page",
which explicitly names both surfaces): on a Chase `transactions` list, each
`account_id` cell links up to its parent account. But the inverse — standing on a
Chase `accounts` **list**, reaching each row's `transactions` — has no affordance.
The operator must open each account's detail page to find the link to its
children. The bounded receiving end already exists (the list page applies
`filter[<field>]=<value>` server-side), and the parent list page already loads
the full connector manifest, so the child streams that declare a `has_one` back to
the displayed parent stream are already in hand. The missing piece is one per-row
link, computed from the row's own record key — the exact inversion of the
per-cell child → parent links the list page already draws.

This change extends the existing reverse requirement's surface from the parent
detail page to the parent list page, so reverse navigation is symmetric with the
forward child → parent navigation across both surfaces. It mirrors how mature
admin/CRM surfaces expose a parent's children from a *list* of parents (Salesforce
related-list links, Django filtered changelist, Stripe scoped lists; see the
companion change's `design-notes/prior-art-filtered-child-list.md`).

## What Changes

- Extend the operator-console requirement for reverse parent → filtered-child-list
  links so it applies on the record **list** page as well as the detail page. On
  the parent **list** page (`/dashboard/records/<connection>/<parent>`), for each
  child stream whose own manifest declares a `has_one` targeting the displayed
  (parent) stream with a non-empty `foreign_key`, the console SHALL render, per
  parent **row**, a navigable link to that child stream's record-**list** page
  filtered by `filter[<child.foreign_key>]=<that row's record key>`.
- Keep every existing constraint from the detail-page rule, applied per row: the
  link target is the filtered child **list**, never a child record-**detail** URL
  built from the parent key; the child collection is not loaded inline to draw the
  link; only child-declared `has_one` relationships (not `has_many`, not
  payload-name heuristics) produce a link; the connector manifest is resolved
  through the dual-namespace resolver; and a reverse link that resolves to the same
  `(child stream, filter field, parent key)` as a forward `has_many` link is
  rendered once.
- Bound the work to the manifest already loaded by the list page: the set of child
  streams declaring a `has_one` back to the displayed parent stream SHALL be
  computed once per page from the already-loaded connector manifest (no new fetch),
  and each parent row's links SHALL be derived by substituting that row's own
  record key as the filter value. The page SHALL NOT issue an additional
  per-row request and SHALL NOT scan or load child records to render the links.
- Console-only, like the detail-page rule. No server, contract, manifest,
  `expand[]` grammar, `filter[…]` grammar, query-parameter, or grant change.
  `GET /v1/streams/<child>/records?expand=<reverse>` continues to fail
  `invalid_expand`.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture` — extends the existing operator-console
  requirement "Operator console SHALL render a reverse parent-to-filtered-child-list
  link from a child-declared `has_one`" so it covers the parent record **list** page
  (per-row reverse links) in addition to the parent record detail page. No server,
  contract, manifest, query-grammar, or grant behavior changes.

### Removed Capabilities

- None.

## Impact

- Affected operator console: the record list page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` wires the
  existing reverse helper (`reverseChildListLinksFromManifest`) once per page from
  the already-loaded connector manifest and renders one filtered-child-list link
  per parent row. The relationship helper module
  `apps/console/src/app/dashboard/records/lib/relationships.ts` gains one small
  pure helper that computes the set of child streams declaring a `has_one` back to
  a parent stream (the page-level prerequisite), reusing the same declared
  `has_one` reading and the same `filteredChildListHref` encoding the detail page
  already uses; no link-semantics duplication.
- Affected manifest surface: none. The child-side `has_one` `relationships[]`
  entries already exist as declared metadata and are read in the reverse direction
  without modification — the same entries the detail-page rule reads.
- Affected public surface: none. The reverse link reuses the existing
  `filter[<field>]=<value>` list query already applied server-side; no new
  `expand[]` request, query parameter, endpoint, manifest field, or
  `expand_capabilities` entry.
- No new dependencies, storage tables, blob semantics, search endpoints, query
  grammar, or owner-auth surfaces.
- No protocol semantics in `spec-*.md` change. PDPP Core remains a
  consent/disclosure protocol; this documents reference-implementation
  operator-console behavior over manifest-declared relationships.
- Relationship to siblings: this change extends the requirement introduced by the
  archived `add-reverse-record-relationship-links` with an additive `## MODIFIED
  Requirements` delta that restates the full requirement body (per OpenSpec
  delta-modify rules) widening the surface from detail-only to detail-and-list. It
  does not alter the child → parent back-link requirement, which already names both
  surfaces.

## Residual Risks

- **Owner-only live render check.** A deployed-console verification that a Chase
  `accounts` **list** page renders a working per-row "transactions" filtered-list
  link is owner-gated (it needs an instance with Chase data). The contract proof is
  the unit tests in `relationships.test.ts`; the live check only confirms
  operator-visible rendering, which is bundled-manifest-derived and
  deploy-revision-independent (the same property under which the detail-page rule's
  live check was satisfied). Recorded as a residual risk per `AGENTS.md` rather than
  held open as a task.
- **Per-row link density.** A parent stream with several child streams declaring a
  `has_one` back to it renders several links per row. In the first-party set the
  count is small (Chase/USAA/YNAB `accounts` have a handful of child streams). The
  links are computed from the already-loaded manifest with no per-row fetch, so the
  cost is href construction only; there is no table scan or N+1 read on the hot
  list page.
- **Dead-link tolerance.** A parent row whose children are ungranted or empty links
  to a filtered list that renders the calm "No records." state — the same
  bounded-empty behavior the detail-page reverse link and the forward `has_many`
  link already accept.
- **Single-scalar `foreign_key` assumption.** As with the detail-page rule, the
  affordance serves a child-declared `has_one` with a single scalar `foreign_key`.
  A composite or array foreign key is a follow-up rule extension, not served here.
