## 1. Contract surface (the wire format moves first)

- [x] 1.1 Add a single `SourceObjectSchema` to `packages/reference-contract/src/public/index.ts` with shape `{ kind: 'connector' | 'provider_native', id: string }` and `additionalProperties: false`.
- [x] 1.2 Replace `AuthorizationDetailBaseSchema`'s `connector_id` and `provider_id` properties with a single `source: SourceObjectSchema` property.
- [x] 1.3 Delete `AuthorizationDetailSchema`'s `oneOf: [{ required: ["connector_id"] }, { required: ["provider_id"] }]` constraint; replace with a `required: ["source"]` rule on the base schema.
- [x] 1.4 Replace `GrantSourceSchema`'s sibling-fields shape with `SourceObjectSchema`. Remove the redundant top-level `binding_kind`, `connector_id`, `provider_id` fields.
- [x] 1.5 Update `ParRequestInput` and `buildParRequest` in `packages/reference-contract/src/builders/index.ts` to accept and pass through the unified source object. Reject legacy `connector_id` / `provider_id` keys at build time with a migration error message that names the new shape.
- [x] 1.6 Re-run contract codegen (`pnpm --filter @pdpp/reference-contract run check:generated` and `verify`); regenerate OpenAPI artifacts. The generated-check command is expected to report dirty generated artifacts before those artifacts are committed.

## 2. Server-side validation collapses to one stanza

- [x] 2.1 In `reference-implementation/server/auth.js`, replace `requireStructuredSourceBinding` with a single validator that branches once on `source.kind` and returns `{ kind, id }`.
- [x] 2.2 Remove the four `hasExactBindingKeys` arms in `requireStructuredPendingRequestBindings` (lines ~648-656) and `requireStructuredGrantBindings` (lines ~755-763); replace with one shape check against the new schema.
- [x] 2.3 Update `describeSourceBinding` (lines ~789-799) to return the canonical source object directly rather than reconstructing `binding_kind` + kind-keyed scalar.
- [x] 2.4 Update `requireGrantManifestForBindings` so the "Unknown native provider" / "Unknown connector" error message names the canonical source object shape rather than the legacy scalar names.

## 3. Storage migration: spine_events

- [x] 3.1 Add a database migration that drops `spine_events.provider_id` and adds `source_kind TEXT` and `source_id TEXT` columns. Migration runs inside one transaction.
- [x] 3.2 Backfill `source_kind` and `source_id` for existing rows from canonical or legacy `data_json.source` / `data_json.source_binding`, payload-level connector/provider fields, existing source columns, legacy `provider_id`, or runtime actor identity for old connector-run rows; log and assert row counts.
- [x] 3.3 Record the schema transition without mutating `version_counter` (SQLite `PRAGMA user_version`; Postgres idempotent column introspection) and add a startup assertion that pre-existing databases re-open and read consistent counts (in line with the architecture spec's "Pre-existing databases SHALL continue to open and operate" requirement).
- [x] 3.4 Update `reference-implementation/lib/spine.ts` types (`SpineEventRecord`, `NormalizedSpineEvent`, `SpineEventRow`) to drop `provider_id` and add `source_kind` and `source_id`. Update the insert SQL (line ~272), the row-to-record mapper (line ~324), the row-to-event mapper (line ~352), the aggregate `pickFirstNonNull` call (line ~504), the filter list (line ~574), the WHERE clause builder (line ~724), and the search-aggregate concat (line ~800).
- [x] 3.5 Update reference-only readers under `/_ref/...` and the spine-search index to query the unified columns. Update the spine-search FTS5 content rebuild script.

## 4. Public route emission

- [x] 4.1 Update every route in `reference-implementation/server/index.js` that emits a source identity to emit the canonical source object. Targets include `/v1/connectors`, `/v1/streams/{stream}`, `/_ref/grants/...`, `/_ref/runs/...`, well-known protected-resource metadata, and owner-mode error responses.
- [x] 4.2 Update the well-known `pdpp_discovery_hints` block (added in `polish-reference-api-discovery-seams`) to use the canonical source-kind connector hint. Remove ambiguity caused by mentioning legacy field names.

## 5. Test surface migration (mechanical, batched)

- [x] 5.1 In `reference-implementation/test/pdpp.test.js`, rewrite legacy source assertions to the canonical `event.data.source.kind` plus `event.data.source.id` shape. (Largest test file: ~352 references.)
- [x] 5.2 Same rewrite in `reference-implementation/test/cli.test.js` (~227 references), `reference-implementation/test/event-spine.test.js`, `reference-implementation/test/query-contract.test.js` (~112), `reference-implementation/test/scheduler.test.js` (~84), and the rest of `reference-implementation/test/**`.
- [x] 5.3 Update test fixtures that build PAR requests or grant payloads to construct the unified source object instead of separate scalars.
- [x] 5.4 Add a new test that asserts the migration error: a request body carrying both a legacy `connector_id` scalar and a `source` object SHALL be rejected with a message that names the canonical shape.
- [x] 5.5 Add a new spine-events test that asserts a polyfill row and a native row are both queryable by `WHERE source_kind = ?` and that no row has a null `source_id`.

## 6. Web bridge and apps/web

- [x] 6.1 Audit `apps/web/` bridge routes for any handler that echoes `connector_id` or `provider_id` from underlying responses; update each to forward the canonical source object.
- [x] 6.2 Update `apps/web/` UI components that read `connector_id` or `provider_id` from API responses (sandbox, trace viewer, dashboard) to read `source.kind` and `source.id`.
- [x] 6.3 Re-render screenshot fixtures or sandbox seed data that hard-codes the legacy fields. Verify the `/sandbox` mock dashboard still tells a coherent story.

## 7. Documentation alignment

- [x] 7.1 Rewrite `README.md` lines 36-39: replace the dual-bullet "native provider access identified publicly with `provider_id` / polyfill access identified publicly with `connector_id`" with a single source-object explanation. Mention legacy names once, in a footnote.
- [x] 7.2 Rewrite `docs/agent-skills/pdpp-data-access/SKILL.md` line ~87 ("Pick `connector_id` xor `provider_id`...") to instruct agents to construct the unified source object. Same for `docs/agent-skills/pdpp-data-access/references/grant-design.md` line ~12.
- [x] 7.3 Update any active design notes in `openspec/changes/` (not archive) that name the legacy scalars in normative text. The shadow-bug note in `add-polyfill-connector-system` does not need rewriting because it speaks to fixture resolution priority, not to public identity shape.
- [x] 7.4 Add a short "previously known as" section to `docs/agent-skills/pdpp-data-access/SKILL.md` that explains the rename for archive-doc readers.

## 8. Validation

- [x] 8.1 Run `pnpm --dir reference-implementation run verify`.
- [x] 8.2 Run `pnpm --dir reference-implementation exec node --test test/event-spine.test.js test/query-contract.test.js test/cli.test.js test/pdpp.test.js`.
- [x] 8.3 Run `pnpm --filter @pdpp/reference-contract run check:generated` and confirm the only failure is the expected dirty generated OpenAPI artifacts before commit.
- [x] 8.4 Run `openspec validate unify-source-binding-vocabulary --strict`.
- [x] 8.5 Run `openspec validate --all --strict`.
- [x] 8.6 Run a representative polyfill-class smoke (one shipped API manifest, one browser-scraper manifest, one file-based manifest through the reference ingest/query path) and confirm matching `spine_events.source_kind` and `source_id` rows are populated with no nulls.
- [x] 8.7 Open a fresh test database and re-open an existing pre-migration database; confirm both flow through the migration path and that the post-migration row count matches the pre-migration row count.
