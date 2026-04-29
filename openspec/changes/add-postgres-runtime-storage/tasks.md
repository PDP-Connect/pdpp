## 1. OpenSpec And Baseline

- [x] 1.1 Create the final Postgres runtime storage OpenSpec artifacts.
- [x] 1.2 Validate `add-postgres-runtime-storage` with `pnpm exec openspec validate add-postgres-runtime-storage --strict`.
- [x] 1.3 Confirm owner workstream status has no blockers before implementation.

## 2. Runtime Backend Configuration

- [x] 2.1 Add explicit storage backend config for `sqlite` default and `postgres` opt-in.
- [x] 2.2 Promote `pg` to runtime dependency scope for Postgres mode.
- [x] 2.3 Add idempotent Postgres bootstrap for records, record changes, blobs, blob bindings, spine events, lexical search state, and semantic search state.
- [x] 2.4 Ensure `PDPP_STORAGE_BACKEND=postgres` fails fast without `PDPP_DATABASE_URL`.

## 3. Records And Blobs Runtime

- [x] 3.1 Implement Postgres record ingest, version allocation, record-change append, pruning, list, get, aggregate, and delete behavior.
- [x] 3.2 Implement Postgres blob upload/read storage and binding behavior.
- [x] 3.3 Wire runtime records/blob routes through the backend-specific capabilities without importing database drivers into operation modules.
- [x] 3.4 Run SQLite and Postgres-gated record/blob conformance or route tests.

## 4. Disclosure Spine Runtime

- [x] 4.1 Implement Postgres spine event emission with stable monotonic `event_seq`.
- [x] 4.2 Implement Postgres spine timeline, search, and correlation reads.
- [x] 4.3 Wire `_ref` spine routes through backend-specific capabilities without changing public envelopes.
- [x] 4.4 Run SQLite and Postgres-gated disclosure spine tests.

## 5. Retrieval Runtime

- [x] 5.1 Implement Postgres lexical index upsert/delete/backfill/progress/search behavior.
- [x] 5.2 Implement Postgres semantic index upsert/delete/backfill/progress/search behavior with pgvector when available and a deterministic fallback when unavailable.
- [x] 5.3 Preserve hybrid search composition by feeding Postgres lexical and semantic result sets through the existing operation boundary.
- [x] 5.4 Run SQLite and Postgres-gated lexical, semantic, and hybrid search tests.

## 6. Docs And Validation

- [x] 6.1 Update README and env/Compose docs for Postgres runtime mode and its no-migration limitation.
- [x] 6.2 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 6.3 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 6.4 Run focused SQLite route/conformance tests for records, blobs, spine, and search.
- [x] 6.5 Run Postgres-gated runtime tests against the profile-gated Compose service.
- [x] 6.6 Run `pnpm exec openspec validate add-postgres-runtime-storage --strict`.
- [x] 6.7 Run `pnpm exec openspec validate --all --strict`.
- [x] 6.8 Run `git diff --check` and a final grep/read consistency pass for old SQLite-only assumptions in touched files.

## 7. Completion Corrections

- [x] 7.1 Extend Postgres bootstrap to cover connector manifests, OAuth clients, grants, tokens, pending consent, owner-device auth, connector state, schedules, active runs, and search cursor snapshots.
- [x] 7.2 Wire authorization helpers so clients, grants, tokens, pending consent, owner-device auth, token introspection, revocation, and client deletion use Postgres in Postgres mode.
- [x] 7.3 Wire connector manifest registry, connector-state store, scheduler store, and active-run registry to Postgres in Postgres mode.
- [x] 7.4 Preserve manifest-declared dataset record-time bounds for Postgres `_ref/dataset/summary`.
- [x] 7.5 Add storage-neutral store factory names and update production call sites away from `createSqlite*` names, keeping SQLite aliases only for compatibility/tests.
- [x] 7.6 Persist lexical/semantic cursor snapshots in Postgres mode or prove they are not required by the runtime Postgres paths.
- [x] 7.7 Update docs to state pgvector is the expected Postgres image path and JSONB vector fallback is only a degraded compatibility fallback.
- [x] 7.8 Add/extend live Postgres runtime tests for auth/control-plane durability, connector state/schedules, dataset time bounds, and storage-neutral factories.
- [x] 7.9 Re-run typecheck, check, broad SQLite default tests, Postgres-gated tests, OpenSpec strict validation, `git diff --check`, final grep/read consistency pass, and owner workstream status.
