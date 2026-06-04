# Tasks — add-reverse-record-relationship-links

This change authorizes one bounded, manifest-grounded reverse navigation
affordance (parent detail page → link to the filtered child list) for the
operator console. This lane delivers the OpenSpec contract only; the console
implementation is a separate, owner-approved lane. Section 1 is the proposal work
done in this lane; sections 2–3 are the deferred implementation slice; section 4
is acceptance.

## 1. Proposal (this lane)

- [x] 1.1 Confirm the forward child → parent path is shipped/green and the
  reverse parent → child path is unauthorized by any active change (verified
  against `tmp/workstreams/ri-relationships-bidir-navigation-v2-report.md` and the
  active change set).
- [x] 1.2 Confirm the bounded receiving end already exists: the stream list page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` parses
  `filter[<field>]=<value>` (`readExactFilters`, `FILTER_PARAM_RE`) and
  `queryRecords` (`apps/console/src/app/dashboard/lib/rs-client.ts`) applies the
  filter server-side via `GET /v1/streams/<child>/records?filter[<fk>]=<v>`.
- [x] 1.3 Confirm the durable spec already houses the bounded forward
  filtered-child-list form ("Reader navigates parent to a filtered child list
  using the child's parent-key field"; "Usable `has_many` relation renders as a
  link to the filtered child list"), so the reverse rule is the inversion of an
  existing pattern, not a new query grammar.
- [x] 1.4 Record the prior-art justification for "parent links to a filtered child
  list, never an inline unbounded load" in
  `design-notes/prior-art-filtered-child-list.md` (Salesforce, Django, Stripe,
  Airtable/Notion, PostgREST/Hasura, ActiveAdmin).
- [x] 1.5 Add the operator-console requirement for parent → filtered-child-list
  reverse links to the `reference-implementation-architecture` capability delta,
  with the Chase `accounts -> transactions[]` proving scenario and the constraint
  scenarios (filtered list not detail URL, no inline load, `has_many` child
  declaration ignored, undeclared field plain text, no reverse expand,
  canonicalization, dedup with any forward `has_many`).
- [x] 1.6 Record in `proposal.md` and `design.md` the archive-time obligation to
  fold the child → parent and parent → child requirements into one coherent
  durable contract naming both directions and both manifest sources.

## 2. Implementation (deferred — owner-approved lane only)

- [ ] 2.1 Add a pure helper to
  `apps/console/src/app/dashboard/records/lib/relationships.ts` that, given the
  connector manifest's streams and the displayed parent stream + parent record
  key, returns one filtered-child-list link per child stream that declares a
  `has_one` with `stream == <parent>` and a non-empty `foreign_key`. The href
  SHALL be `/dashboard/records/<conn>/<child>?filter[<fk>]=<parentKey>`, with each
  segment and the filter value percent-encoded. The helper SHALL NOT build a child
  record-detail URL and SHALL NOT load any child records.
- [ ] 2.2 Wire the helper into the parent record detail page
  `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx`,
  resolving the manifest via `findManifestForConnectorId` (URL-form `connector_id`
  + short `connector_key`), and render the reverse links in the existing "Related"
  section. Deduplicate against any forward `has_many` `buildRelatedLinks` target
  resolving to the same `(child stream, filter field, parent key)`.
- [ ] 2.3 Keep the server, manifests, `expand[]` grammar, and `filter[…]` grammar
  unchanged. No new endpoint, query parameter, manifest field, or
  `expand_capabilities` entry.

## 3. Verification (deferred — with the implementation lane)

- [ ] 3.1 Add focused unit tests in
  `apps/console/src/app/dashboard/records/lib/relationships.test.ts`:
  Chase-shaped `accounts` parent yields a `transactions?filter[account_id]=<key>`
  list link; the link is a list URL with a `filter[…]` query, never a
  `.../transactions/<accountKey>` detail URL; a child-declared `has_many` produces
  no reverse link; a parent field not covered by any child-declared `has_one`
  produces no link; percent-encoding of connection/stream/filter value; URL-form
  vs short connector key both resolve; dedup against a forward `has_many` target.
- [ ] 3.2 Run `node --test --import tsx apps/console/src/app/dashboard/records/lib/relationships.test.ts`
  and `pnpm --filter pdpp-console run types:check`; confirm green.
- [ ] 3.3 (Owner, optional) Live-verify on a deployed Chase-bearing instance that an
  `accounts` detail page renders a working "transactions" filtered-list link.
  Bundled-manifest-derived and deploy-revision-independent, so the unit tests are
  the authoritative contract proof; the live check only confirms the
  operator-visible rendering. Owner-gated because it needs an instance with Chase
  data.

## 4. Acceptance checks

- [x] 4.1 `openspec validate add-reverse-record-relationship-links --strict` (valid).
- [x] 4.2 `openspec validate --all --strict` (no regression).
- [x] 4.3 `git diff --check` (no whitespace errors).
- [x] 4.4 Confirm this lane adds no code/manifest/server/contract diffs — OpenSpec
  artifacts and the design note only.
