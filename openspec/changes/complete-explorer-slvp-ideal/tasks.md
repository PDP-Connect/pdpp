# Tasks: complete-explorer-slvp-ideal

Tasks are grouped so each checkbox is a single committable slice. Product-UI-only
slices (no contract change) and contract-gated slices are separated. A slice
fully covered by tests does not need a browser pass; reserve the browser pass for
the single end-to-end journey in section 6.

## 1. Read-contract: declared field type

- [ ] 1.1 Align the live reference `ConnectorManifest` stream-field type to accept an optional declared presentation `type`, matching the shape the sandbox demo manifests already encode (`type`/`semantic_class`).
- [ ] 1.2 Surface the declared `type` on each `field_capabilities` entry returned by `GET /v1/streams/<stream>`; omit it when the manifest does not declare it.
- [ ] 1.3 Regenerate and verify `@pdpp/reference-contract` so the `field_capabilities` entry carries the optional `type` without changing filter/grant/retrieval semantics.
- [ ] 1.4 Add reference-server tests: declared-type field surfaces `type`; undeclared field omits it; declared `type` does not alter exact-filter, range, lexical/semantic, or grant usability.

## 2. Read-contract: bounded window metadata

- [ ] 2.1 Add an optional `meta.window` (`total`, `earliest_at`, `latest_at`) to `GET /v1/streams/:stream/records`, computed under the same grant projection and the same exact/declared range-filter validation as the records.
- [ ] 2.2 Omit `meta.window` when the aggregate cannot be computed cheaply or is not implemented; never estimate.
- [ ] 2.3 Regenerate and verify `@pdpp/reference-contract` for the additive `meta.window` shape.
- [ ] 2.4 Add reference-server tests: window figures reflect the filtered, grant-scoped corpus; absence is honest; no full-corpus figure is synthesized from a bounded sample.

## 3. Explorer cards: typed dispatch with heuristic fallback

- [ ] 3.1 Consume the declared `field_capabilities[].type` in `record-kind.ts` / `record-preview.ts`, dispatching cards from the declared type when present.
- [ ] 3.2 Keep the presentation-only heuristic as the explicit fallback for streams without a declared type and for search hits without a body; degrade to a generic card rather than guessing.
- [ ] 3.3 Apply the `.impeccable` card direction: thin left-rail accent keyed to record kind (copper for human/message/person, cool blue for protocol/money/system), lead with the identifying fact, monospace for protocol data.
- [ ] 3.4 Mirror the changes into `apps/console`. Add/extend unit tests proving declared-type dispatch and heuristic fallback against fixtures.

## 4. Explorer honesty: grant projection and blob affordances

- [ ] 4.1 Consume the existing `field_capabilities` grant-usability signal so fields projected out under the active token render as withheld, not silently omitted — without introducing client-grant chrome.
- [ ] 4.2 Render a grant-aware preview/download affordance for records whose stream declares a `blob` field type and that carry a `blob_ref`, reading only through the existing blob read path; represent out-of-projection blobs as unavailable.
- [ ] 4.3 Source corpus/activity summaries from `meta.window` when present; otherwise omit or label as derived from the bounded recency sample. Never compute a full-corpus figure by unbounded fan-out.
- [ ] 4.4 Add unit/invariant tests for withheld-field representation, blob affordance gating, and the bounded-summary honesty rule.

## 5. Information architecture and sandbox parity

- [ ] 5.1 Confirm/finish Explore as the single records canvas (recency / time-window / query lenses), Timeline reachable as an Explore time-window lens, `/dashboard/search` reserved for spine artifact jumps with free-text record queries routed to Explore.
- [ ] 5.2 Ensure navigation labels do not present two surfaces that do the same job under different names; update subnav/nav chrome accordingly.
- [ ] 5.3 Confirm `/sandbox/explore` renders the same explorer view through the sandbox data source with deterministic fictional data and no owner token; retired sandbox records routes redirect to `/sandbox/explore`.
- [ ] 5.4 Label sandbox-only divergences (illustrative read URLs, seeded data) as specimens. Extend `page.invariants.test.ts` drift tests across live, console, and sandbox.

## 6. Acceptance checks

- [ ] 6.1 `openspec validate complete-explorer-slvp-ideal --strict` passes.
- [ ] 6.2 Contract slices: `pnpm --filter @pdpp/reference-contract run verify` and `run check:generated` pass; targeted reference-server `node --test` over `GET /v1/streams` and record-list paths pass, including the undeclared-manifest-yields-current-shape assertion.
- [ ] 6.3 Product-UI slices: `apps/web` and `apps/console` explorer/search/records tests pass; `page.invariants.test.ts` drift tests pass; `pnpm --dir apps/web run types:check` and `run check` pass (note any pre-existing baseline failures explicitly).
- [ ] 6.4 Single browser UAT journey (run once, at the end, owner-live-gated): on `/dashboard/explore`, typed cards render for a typed connection; two accounts of the same connector stay distinct; a withheld field shows as withheld; a blob record shows a grant-aware affordance; a `meta.window` summary reads honestly or is absent without claiming a corpus figure; Timeline is reachable as an Explore lens; `/dashboard/search` jumps by id; `/sandbox/explore` renders the seeded specimen.
- [ ] 6.5 `git diff --check` reports no whitespace errors on the change.
