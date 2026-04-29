## 1. OpenSpec And Baseline

- [ ] 1.1 Create the final Postgres runtime storage OpenSpec artifacts.
- [ ] 1.2 Validate `add-postgres-runtime-storage` with `pnpm exec openspec validate add-postgres-runtime-storage --strict`.
- [ ] 1.3 Confirm owner workstream status has no blockers before implementation.

## 2. Runtime Backend Configuration

- [ ] 2.1 Add explicit storage backend config for `sqlite` default and `postgres` opt-in.
- [ ] 2.2 Promote `pg` to runtime dependency scope for Postgres mode.
- [ ] 2.3 Add idempotent Postgres bootstrap for records, record changes, blobs, blob bindings, spine events, lexical search state, and semantic search state.
- [ ] 2.4 Ensure `PDPP_STORAGE_BACKEND=postgres` fails fast without `PDPP_DATABASE_URL`.

## 3. Records And Blobs Runtime

- [ ] 3.1 Implement Postgres record ingest, version allocation, record-change append, pruning, list, get, aggregate, and delete behavior.
- [ ] 3.2 Implement Postgres blob upload/read storage and binding behavior.
- [ ] 3.3 Wire runtime records/blob routes through the backend-specific capabilities without importing database drivers into operation modules.
- [ ] 3.4 Run SQLite and Postgres-gated record/blob conformance or route tests.

## 4. Disclosure Spine Runtime

- [ ] 4.1 Implement Postgres spine event emission with stable monotonic `event_seq`.
- [ ] 4.2 Implement Postgres spine timeline, search, and correlation reads.
- [ ] 4.3 Wire `_ref` spine routes through backend-specific capabilities without changing public envelopes.
- [ ] 4.4 Run SQLite and Postgres-gated disclosure spine tests.

## 5. Retrieval Runtime

- [ ] 5.1 Implement Postgres lexical index upsert/delete/backfill/progress/search behavior.
- [ ] 5.2 Implement Postgres semantic index upsert/delete/backfill/progress/search behavior with pgvector when available and a deterministic fallback when unavailable.
- [ ] 5.3 Preserve hybrid search composition by feeding Postgres lexical and semantic result sets through the existing operation boundary.
- [ ] 5.4 Run SQLite and Postgres-gated lexical, semantic, and hybrid search tests.

## 6. Docs And Validation

- [ ] 6.1 Update README and env/Compose docs for Postgres runtime mode and its no-migration limitation.
- [ ] 6.2 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 6.3 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 6.4 Run focused SQLite route/conformance tests for records, blobs, spine, and search.
- [ ] 6.5 Run Postgres-gated runtime tests against the profile-gated Compose service.
- [ ] 6.6 Run `pnpm exec openspec validate add-postgres-runtime-storage --strict`.
- [ ] 6.7 Run `pnpm exec openspec validate --all --strict`.
- [ ] 6.8 Run `git diff --check` and a final grep/read consistency pass for old SQLite-only assumptions in touched files.
