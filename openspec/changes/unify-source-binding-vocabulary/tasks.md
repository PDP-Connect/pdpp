## 1. Contract surface (the wire format moves first)

- [ ] 1.1 Add a single `SourceObjectSchema` to `packages/reference-contract/src/public/index.ts` with shape `{ kind: 'connector' | 'provider_native', id: string }` and `additionalProperties: false`.
- [ ] 1.2 Replace `AuthorizationDetailBaseSchema`'s `connector_id` and `provider_id` properties with a single `source: SourceObjectSchema` property.
- [ ] 1.3 Delete `AuthorizationDetailSchema`'s `oneOf: [{ required: ["connector_id"] }, { required: ["provider_id"] }]` constraint; replace with a `required: ["source"]` rule on the base schema.
- [ ] 1.4 Replace `GrantSourceSchema`'s sibling-fields shape with `SourceObjectSchema`. Remove the redundant top-level `binding_kind`, `connector_id`, `provider_id` fields.
- [ ] 1.5 Update `ParRequestInput` and `buildParRequest` in `packages/reference-contract/src/builders/index.ts` to accept and pass through the unified source object. Reject legacy `connector_id` / `provider_id` keys at build time with a migration error message that names the new shape.
- [ ] 1.6 Re-run contract codegen (`pnpm --filter @pdpp/reference-contract run check:generated` and `verify`); regenerate OpenAPI artifacts.

## 2. Server-side validation collapses to one stanza

- [ ] 2.1 In `reference-implementation/server/auth.js`, replace `requireStructuredSourceBinding` with a single validator that branches once on `source.kind` and returns `{ kind, id }`.
- [ ] 2.2 Remove the four `hasExactBindingKeys` arms in `requireStructuredPendingRequestBindings` (lines ~648-656) and `requireStructuredGrantBindings` (lines ~755-763); replace with one shape check against the new schema.
- [ ] 2.3 Update `describeSourceBinding` (lines ~789-799) to return the canonical source object directly rather than reconstructing `binding_kind` + kind-keyed scalar.
- [ ] 2.4 Update `requireGrantManifestForBindings` so the "Unknown native provider" / "Unknown connector" error message names the canonical source object shape rather than the legacy scalar names.

## 3. Storage migration: spine_events

- [ ] 3.1 Add a database migration that drops `spine_events.provider_id` and adds `source_kind TEXT` and `source_id TEXT` columns. Migration runs inside one transaction.
- [ ] 3.2 Backfill `source_kind` and `source_id` for existing rows from `data_json.source.binding_kind` and `data_json.source.{connector_id|provider_id}`. Fail the migration if any row has a `data_json.source` shape the backfill cannot interpret; log the row count.
- [ ] 3.3 Bump `version_counter` and add a startup assertion that pre-existing databases re-open and read consistent counts (in line with the architecture spec's "Pre-existing databases SHALL continue to open and operate" requirement).
- [ ] 3.4 Update `reference-implementation/lib/spine.ts` types (`SpineEventRecord`, `NormalizedSpineEvent`, `SpineEventRow`) to drop `provider_id` and add `source_kind` and `source_id`. Update the insert SQL (line ~272), the row-to-record mapper (line ~324), the row-to-event mapper (line ~352), the aggregate `pickFirstNonNull` call (line ~504), the filter list (line ~574), the WHERE clause builder (line ~724), and the search-aggregate concat (line ~800).
- [ ] 3.5 Update reference-only readers under `/_ref/...` and the spine-search index to query the unified columns. Update the spine-search FTS5 content rebuild script.

## 4. Public route emission

- [ ] 4.1 Update every route in `reference-implementation/server/index.js` that emits a source identity to emit the canonical source object. Targets include `/v1/connectors`, `/v1/streams/{stream}`, `/_ref/grants/...`, `/_ref/runs/...`, well-known protected-resource metadata, and owner-mode error responses.
- [ ] 4.2 Update the well-known `pdpp_discovery_hints` block (added in `polish-reference-api-discovery-seams`): rename `owner_polyfill_requires_connector_id` to `owner_polyfill_requires_source_kind_connector` (or add the new flag and deprecate the old; reviewer to choose). Remove ambiguity caused by mentioning legacy field names.

## 5. Test surface migration (mechanical, batched)

- [ ] 5.1 In `reference-implementation/test/pdpp.test.js`, rewrite assertions of the form `event.data.source.provider_id === X` to `event.data.source.kind === 'provider_native' && event.data.source.id === X`. Same shape for `connector_id`. (Largest test file: ~352 references.)
- [ ] 5.2 Same rewrite in `reference-implementation/test/cli.test.js` (~227 references), `reference-implementation/test/event-spine.test.js`, `reference-implementation/test/query-contract.test.js` (~112), `reference-implementation/test/scheduler.test.js` (~84), and the rest of `reference-implementation/test/**`.
- [ ] 5.3 Update test fixtures that build PAR requests or grant payloads to construct the unified source object instead of separate scalars.
- [ ] 5.4 Add a new test that asserts the migration error: a request body carrying both a legacy `connector_id` scalar and a `source` object SHALL be rejected with a message that names the canonical shape.
- [ ] 5.5 Add a new spine-events test that asserts a polyfill row and a native row are both queryable by `WHERE source_kind = ?` and that no row has a null `source_id`.

## 6. Web bridge and apps/web

- [ ] 6.1 Audit `apps/web/` bridge routes for any handler that echoes `connector_id` or `provider_id` from underlying responses; update each to forward the canonical source object.
- [ ] 6.2 Update `apps/web/` UI components that read `connector_id` or `provider_id` from API responses (sandbox, trace viewer, dashboard) to read `source.kind` and `source.id`.
- [ ] 6.3 Re-render screenshot fixtures or sandbox seed data that hard-codes the legacy fields. Verify the `/sandbox` mock dashboard still tells a coherent story.

## 7. Documentation alignment

- [ ] 7.1 Rewrite `README.md` lines 36-39: replace the dual-bullet "native provider access identified publicly with `provider_id` / polyfill access identified publicly with `connector_id`" with a single source-object explanation. Mention legacy names once, in a footnote.
- [ ] 7.2 Rewrite `docs/agent-skills/pdpp-data-access/SKILL.md` line ~87 ("Pick `connector_id` xor `provider_id`...") to instruct agents to construct the unified source object. Same for `docs/agent-skills/pdpp-data-access/references/grant-design.md` line ~12.
- [ ] 7.3 Update any active design notes in `openspec/changes/` (not archive) that name the legacy scalars in normative text. The shadow-bug note in `add-polyfill-connector-system` does not need rewriting because it speaks to fixture resolution priority, not to public identity shape.
- [ ] 7.4 Add a short "previously known as" section to `docs/agent-skills/pdpp-data-access/SKILL.md` that explains the rename for archive-doc readers.

## 8. Validation

- [ ] 8.1 Run `pnpm --dir reference-implementation run verify`.
- [ ] 8.2 Run `pnpm --dir reference-implementation exec node --test test/event-spine.test.js test/query-contract.test.js test/cli.test.js test/pdpp.test.js`.
- [ ] 8.3 Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [ ] 8.4 Run `openspec validate unify-source-binding-vocabulary --strict`.
- [ ] 8.5 Run `openspec validate --all --strict`.
- [ ] 8.6 Run a full polyfill connector smoke (one connector per realization class — one API connector, one browser-scraper, one file-based) end-to-end and confirm `spine_events.source_kind` and `source_id` are populated correctly with no nulls.
- [ ] 8.7 Open a fresh test database and re-open an existing pre-migration database; confirm both flow through the migration path and that the post-migration row count matches the pre-migration row count.
