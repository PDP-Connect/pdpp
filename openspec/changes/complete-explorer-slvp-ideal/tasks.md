# Tasks: complete-explorer-slvp-ideal

Tasks are grouped so each checkbox is a single committable slice. Product-UI-only
slices (no contract change) and contract-gated slices are separated. A slice
fully covered by tests does not need a browser pass; reserve the browser pass for
the single end-to-end journey in section 6.

## 1. Read-contract: declared field type

- [x] 1.1 Align the live reference `ConnectorManifest` stream-field type to accept an optional declared presentation `type`, matching the shape the sandbox demo manifests already encode (`type`/`semantic_class`). (Live manifest stream type now accepts `fields[]` / `schema.fields[]` declarations with `{ name, type, semantic_class }`, plus `schema.properties[field].x_pdpp_type` for JSON Schema extension compatibility.)
- [x] 1.2 Surface the declared `type` on each `field_capabilities` entry returned by `GET /v1/streams/<stream>`; omit it when the manifest does not declare it. (`buildFieldCapabilities` reads `x_pdpp_type` first, then sandbox-shaped field declarations, and emits `type` only when a non-empty string is declared.)
- [x] 1.3 Regenerate and verify `@pdpp/reference-contract` so the `field_capabilities` entry carries the optional `type` without changing filter/grant/retrieval semantics. (Generated OpenAPI updates only `/v1/schema` and `/v1/streams/{stream}` to add optional `field_capabilities[].type`; no route additions/removals.)
- [x] 1.4 Add reference-server tests: declared-type field surfaces `type`; undeclared field omits it; declared `type` does not alter exact-filter, range, lexical/semantic, or grant usability. (`reference-implementation/test/rs-streams-field-declared-type.test.js` covers both `x_pdpp_type` and sandbox-shaped `fields[]` carriers.)

## 2. Read-contract: bounded window metadata

- [x] 2.1 Add an optional `meta.window` (`total`, `earliest_at`, `latest_at`) to `GET /v1/streams/:stream/records`, computed under the same grant projection and the same exact/declared range-filter validation as the records. (`window=exact` is opt-in; SQLite computes logical `consent_time_field` bounds; fan-in merges all-present windows.)
- [x] 2.2 Omit `meta.window` when the aggregate cannot be computed cheaply or is not implemented; never estimate. (Absent/`none` omits; `changes_since` rejects `window`; Postgres validates but omits this tranche rather than substituting ingest time.)
- [x] 2.3 Regenerate and verify `@pdpp/reference-contract` for the additive `meta.window` shape. (After event-sub generator repair, generated OpenAPI/docs change only `/v1/streams/{stream}/records` for `window` query + `meta.window` response schema.)
- [x] 2.4 Add reference-server tests: window figures reflect the filtered, grant-scoped corpus; absence is honest; no full-corpus figure is synthesized from a bounded sample. (`reference-implementation/test/records-meta-window.test.js`.)

## 3. Explorer cards: typed dispatch with heuristic fallback

- [x] 3.1 Consume the declared `field_capabilities[].type` in `record-kind.ts` / `record-preview.ts`, dispatching cards from the declared type when present. (`classifyRecordKind` gains a `fieldTypes` map as the preferred signal; the explore assembler extracts declared types from the manifest via `x_pdpp_type` / `fields[]` / `schema.fields[]` — the same carriers `buildFieldCapabilities` reads — and threads them through every body-present feed loader. `buildRecordPreview` is unchanged: the declared-type dispatch already routes to the right preview builder.)
- [x] 3.2 Keep the presentation-only heuristic as the explicit fallback for streams without a declared type and for search hits without a body; degrade to a generic card rather than guessing. (Absent/unrecognized declared types fall through to the stream-name/field-name heuristic unchanged; no-body search hits derive at most a kind tag — `buildRecordPreview` still returns null without a body, so no precise card is invented.)
- [x] 3.3 Apply the `.impeccable` card direction: use a true hairline rule, inline kind marker, or surface tint keyed to record kind (copper for human/message/person, cool blue for protocol/money/system), lead with the identifying fact, monospace for protocol data, and avoid decorative side-stripe card treatments. (Replaced the 3px left rail with a true 1px hairline rule keyed to the temperature duality — copper `--human` for message, cool blue `--primary` for money/event/system; protocol data stays monospace; no side-stripe wider than 1px.)
- [x] 3.4 Mirror the changes into `apps/console`. Add/extend unit tests proving declared-type dispatch and heuristic fallback against fixtures. (Mirrored byte-identically in `apps/console` lib/tests and logically in the structurally-different console assembler/view; `record-kind.test.ts` adds declared-type dispatch + fallback cases; `sandbox/_demo/data-source.test.ts` proves declared types reach the Explorer via the sandbox manifest's `x_pdpp_type` carrier.)

## 4. Explorer honesty: grant projection and blob affordances

- [x] 4.1 Consume the existing `field_capabilities` grant-usability signal so fields reported unusable under the active metadata render as withheld, not silently omitted — without introducing client-grant chrome on the owner-token Explorer. (`getStreamMetadata` is now part of the live/sandbox dashboard data-source seam; recency/time-range/peek loaders consume `field_capabilities` and render unusable fields as withheld in the field-level peek model, without adding client-grant chrome to owner-token Explorer.)
- [x] 4.2 Render a grant-aware preview/download affordance for records whose stream declares a `blob` field type and that carry a `blob_ref`, reading only through the existing blob read path; represent out-of-projection blobs as unavailable. (`buildBlobAffordance` gates on declared `type: "blob"` plus active grant usability, links only the existing `blob_ref.fetch_url`/`/v1/blobs/{blob_id}` path, and marks projected-out blobs unavailable; the sandbox includes a deterministic `tax_documents.blob_ref` fixture.)
- [x] 4.3 Source corpus/activity summaries from `meta.window` when present; otherwise omit or label as derived from the bounded recency sample. Never compute a full-corpus figure by unbounded fan-out. (Recency and time-window list calls request `window=exact`; a separate "Loaded stream window" corpus caption renders only when all successful stream reads returned exact window metadata, while the activity strip remains explicitly derived from the bounded visible feed.)
- [x] 4.4 Add unit/invariant tests for withheld-field representation, blob affordance gating, and the bounded-summary honesty rule. (Added `explorer-utils.test.ts` in `apps/web` and `apps/console`, extended dashboard data-source invariants, and extended sandbox fixture tests for withheld fields, blob refs, and exact window metadata; focused checks green.)

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
