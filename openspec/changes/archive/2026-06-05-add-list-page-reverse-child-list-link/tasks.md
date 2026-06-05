# Tasks — add-list-page-reverse-child-list-link

This change extends the shipped reverse parent → filtered-child-list affordance
(detail page only) to the parent record **list** page, rendered per row, so reverse
navigation is symmetric with the forward child → parent navigation across both
surfaces.

## 1. Proposal (this lane)

- [x] 1.1 Confirm the detail-page reverse link is shipped/green and pinned by the
  durable requirement "Operator console SHALL render a reverse
  parent-to-filtered-child-list link from a child-declared `has_one`"
  (`add-reverse-record-relationship-links`, commit `e85b068a`,
  `reverseChildListLinksFromManifest`).
- [x] 1.2 Confirm the child → parent direction already renders on **both** the list
  page and the detail page (durable requirement "Operator console SHALL render
  manifest-declared parent links on the child record page", list page wiring via
  `childHasOneBackLinkForField`, commits `45671760`/`c2243fdf`), establishing the
  asymmetry this change closes.
- [x] 1.3 Confirm the list page already loads the full connector manifest
  (`listConnectorManifests` → `findManifestForConnectorId` →
  `connectorManifest.streams`) and applies `filter[<field>]=<value>` server-side
  (`readExactFilters` → `queryRecords`), so the reverse links need no new fetch and
  no new query grammar.
- [x] 1.4 Add the `## MODIFIED Requirements` delta widening the reverse requirement's
  surface from detail-only to detail-and-list, restating the full requirement body
  with the per-row list-page obligations and the no-per-row-fetch / no-child-scan
  constraint, plus list-page scenarios.

## 2. Implementation

- [x] 2.1 Add a small pure helper
  `reverseChildListEdgesFromManifest(connectorStreams, parentStream)` to
  `apps/console/src/app/dashboard/records/lib/relationships.ts` returning the set of
  `(child stream, foreign_key)` reverse edges declared against `parentStream` — the
  page-level "does this stream have reverse child edges?" prerequisite. It reads the
  same child-declared `has_one` entries as `reverseChildListLinksFromManifest` (no
  new relationship semantics, no payload heuristics).
- [x] 2.2 Wire the list page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` to compute
  the reverse-edge set once per page from the already-loaded
  `connectorManifest.streams`, and, when non-empty, render per row a filtered-child-
  list link per edge by calling the existing
  `reverseChildListLinksFromManifest(connectorStreams, { connectionId, parentStream:
  streamName, parentRecordKey: row.id })`. No new fetch; href construction only.
- [x] 2.3 Render the per-row reverse links as compact row-navigation chrome distinct
  from the row's record-detail link and the per-cell child → parent links, labeled
  by child stream and `has_many` direction (matching the detail page's reverse-link
  label form), present on both the desktop table and the mobile list.
- [x] 2.4 Keep the server, manifests, `expand[]` grammar, and `filter[…]` grammar
  unchanged. No new endpoint, query parameter, manifest field, or
  `expand_capabilities` entry.

## 3. Verification

- [x] 3.1 Add focused unit tests in
  `apps/console/src/app/dashboard/records/lib/relationships.test.ts`:
  `reverseChildListEdgesFromManifest` returns the correct child-stream set for a
  Chase-shaped `accounts` parent and is empty for a childless or missing stream; a
  per-row call to `reverseChildListLinksFromManifest` with a row key yields a
  `transactions?filter[account_id]=<rowKey>` list link, never a
  `.../transactions/<rowKey>` detail URL; two distinct row keys produce distinct
  filter values; a child-declared `has_many` produces no reverse edge/link;
  percent-encoding of connection/child stream/filter value matches the detail page;
  URL-form vs short connector key both resolve via `findManifestForConnectorId`.
- [x] 3.2 Run `node --test --import tsx apps/console/src/app/dashboard/records/lib/relationships.test.ts`
  and `pnpm --filter pdpp-console run types:check`; confirm green.
- [ ] 3.3 (Owner, optional) Live-verify on a deployed Chase-bearing instance that the
  `accounts` **list** page renders a working per-row "transactions" filtered-list
  link. Owner-gated; recorded as a `## Residual Risks` entry in `proposal.md` per
  `AGENTS.md`. The unit tests remain the authoritative contract proof; the live check
  only confirms operator-visible rendering, which is bundled-manifest-derived and
  deploy-revision-independent.

## 4. Acceptance checks

- [x] 4.1 `openspec validate add-list-page-reverse-child-list-link --strict` (valid).
- [x] 4.2 `openspec validate --all --strict` (no regression).
- [x] 4.3 `git diff --check` (no whitespace errors).
- [x] 4.4 Confirm the diff is console-only: one pure helper + one list-page wiring +
  tests; no server, manifest, contract, or query-grammar change.
