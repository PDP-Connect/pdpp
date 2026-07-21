# Migrating PDPP storage between SQLite and Postgres

Status: reference-experimental. This is an RI operator surface, not a PDPP Core or Collection Profile protocol contract.

## When to migrate

**Migrate to Postgres when:**
- Deploying to production with multiple server instances (Postgres handles concurrent writes; SQLite's file locking does not).
- Running horizontally scaled deployments (load balancers, stateless containers).
- Needing isolation between tenants or environments; separate Postgres databases provide hard boundaries.

**Stay on SQLite when:**
- Single-instance hobby or development deployments.
- Zero dependencies preferred (SQLite embedded in the runtime; Postgres requires external infrastructure).
- Local data minimizes latency concerns (single-region, LAN-only PDPP instances).

The actual decision hinges on **concurrency model**, not data volume. A 10 GB SQLite works fine in single-process mode; a 100 MB Postgres is essential if multiple writers exist.

## Prerequisites

1. **PDPP server stopped.** Live migration is not supported. Writers on the source database after the snapshot begins will silently diverge from the target (no error, data loss). Stop all PDPP processes, confirm with `lsof` on the source DB file if uncertain:
   ```shell
   lsof data/pdpp.sqlite
   ```
   Should return zero results.

2. **Source database reachable** and readable (SQLite file or Postgres connection string valid).

3. **Target database reachable** and writable.

4. **For Postgres targets:** pgvector extension installed in the target database.
   - Reference deployment uses `pgvector/pgvector:pg16` container image.
   - Extension automatically loads with the schema bootstrap; no manual `CREATE EXTENSION` required.
   - If pgvector is missing, schema bootstrap will fail with a clear error.

## The four commands

All commands use the CLI entry point:

```shell
node scripts/migrate-storage/cli.mjs <command> --from <source> --to <target> [options]
```

### plan

**Purpose:** Estimate migration size and duration. Non-destructive; reads source only.

**Reads:** Source database (metadata and row counts per table).

**Writes:** Nothing.

**Invocation:**

```shell
node scripts/migrate-storage/cli.mjs plan \
  --from sqlite://./data/pdpp.sqlite \
  --to postgres://user:password@localhost:5432/pdpp
```

**Sample output:**

```
Plan for sqlite://./data/pdpp.sqlite -> postgres://user:password@localhost:5432/pdpp

Non-derived tables (will be migrated):
  connectors                        12 rows
  oauth_clients                      4 rows
  grants                           218 rows
  tokens                          1843 rows
  pending_consents                  42 rows
  owner_device_auth                 0 rows
  device_exporters                  8 rows
  device_ingest_credentials        16 rows
  device_enrollment_codes           0 rows
  device_source_instances           8 rows
  device_ingest_batch_outcomes      0 rows
  source_webhook_events             0 rows
  connector_state                  12 rows
  grant_connector_state             12 rows
  connector_schedules               0 rows
  controller_active_runs            0 rows
  scheduler_run_history          4521 rows
  scheduler_last_run_times         12 rows
  version_counter                   1 row
  blobs                         18420 rows
  blob_bindings                  12580 rows
  records                         9831 rows
  record_changes                 28194 rows
  spine_events                      0 rows

Subtotal (non-derived): 75,943 rows

Derived tables (will be rebuilt by runtime on first boot):
  lexical_search_index
  lexical_search_snapshots
  lexical_search_meta
  semantic_search_blob
  semantic_search_snapshots
  semantic_search_meta
  semantic_search_backfill_progress

Estimated duration: 2 minutes on typical hardware (SSD, gigabit network)
```

**Exit codes:**
- `0`: Success. Plan computed.
- `1`: Source unreachable or malformed.
- `2`: Source/target schema version mismatch (incompatible PDPP versions).

### diff

**Purpose:** Detect schema drift between source and target before executing migration. Use after plan to confirm the target is clean (empty) or compatible.

**Reads:** Both source and target (schema and row counts).

**Writes:** Nothing.

**Invocation:**

```shell
node scripts/migrate-storage/cli.mjs diff \
  --from sqlite://./data/pdpp.sqlite \
  --to postgres://user:password@localhost:5432/pdpp
```

**Sample output (no drift):**

```
Diff for sqlite://./data/pdpp.sqlite vs postgres://user:password@localhost:5432/pdpp

Schema comparison:
  connectors                         MATCH
  oauth_clients                      MATCH
  grants                             MATCH
  tokens                             MATCH
  ...
  spine_events                       MATCH

Row counts:
  connectors                         0 vs 0 ✓
  oauth_clients                      0 vs 0 ✓
  grants                             0 vs 0 ✓
  ...

Result: COMPATIBLE. Target is empty. Safe to execute.
```

**Sample output (drift detected):**

```
Diff for sqlite://./data/pdpp.sqlite vs postgres://user:password@localhost:5432/pdpp

Schema comparison:
  grants                             COLUMN MISMATCH
    Source has column 'expires_at' (TEXT)
    Target has column 'expires_at' (BIGINT)

Row counts:
  grants                             218 vs 218 ✓

Result: INCOMPATIBLE. Schema differs on column type. See details above.
```

**Exit codes:**
- `0`: Schema and row counts match. Safe to execute.
- `1`: Schema mismatch or row count divergence detected. Inspect output; may indicate version skew or incomplete prior migration.
- `2`: One database unreachable.

### execute

**Purpose:** Perform the actual migration. Destructive on the target; reads all rows from source and inserts into target. Transactional per table; failures roll back that table's transaction and halt (migration is restartable but not resumable).

**Reads:** Entire source database.

**Writes:** Entire target database (clears existing data in migrated tables; leaves derived tables untouched).

**Invocation:**

```shell
node scripts/migrate-storage/cli.mjs execute \
  --from sqlite://./data/pdpp.sqlite \
  --to postgres://user:password@localhost:5432/pdpp
```

**Sample output:**

```
Executing sqlite://./data/pdpp.sqlite -> postgres://user:password@localhost:5432/pdpp

Migrating non-derived tables (24 total):
  connectors                        12 rows → SUCCESS (45ms)
  oauth_clients                      4 rows → SUCCESS (12ms)
  grants                           218 rows → SUCCESS (87ms)
  tokens                          1843 rows → SUCCESS (156ms)
  pending_consents                  42 rows → SUCCESS (34ms)
  owner_device_auth                 0 rows → SUCCESS (8ms)
  device_exporters                  8 rows → SUCCESS (19ms)
  device_ingest_credentials        16 rows → SUCCESS (24ms)
  device_enrollment_codes           0 rows → SUCCESS (6ms)
  device_source_instances           8 rows → SUCCESS (18ms)
  device_ingest_batch_outcomes      0 rows → SUCCESS (7ms)
  source_webhook_events             0 rows → SUCCESS (5ms)
  connector_state                  12 rows → SUCCESS (22ms)
  grant_connector_state             12 rows → SUCCESS (26ms)
  connector_schedules               0 rows → SUCCESS (5ms)
  controller_active_runs            0 rows → SUCCESS (4ms)
  scheduler_run_history          4521 rows → SUCCESS (289ms)
  scheduler_last_run_times         12 rows → SUCCESS (34ms)
  version_counter                   1 row → SUCCESS (8ms)
  blobs                         18420 rows → SUCCESS (1243ms)
  blob_bindings                  12580 rows → SUCCESS (987ms)
  records                         9831 rows → SUCCESS (654ms)
  record_changes                 28194 rows → SUCCESS (1876ms)
  spine_events                      0 rows → SUCCESS (3ms)

Total: 75,943 rows migrated in 6.8 seconds.

Skipping derived tables (rebuilt on first boot):
  lexical_search_index
  lexical_search_snapshots
  lexical_search_meta
  semantic_search_blob
  semantic_search_snapshots
  semantic_search_meta
  semantic_search_backfill_progress

Migration complete. Next: run verify, then update PDPP_STORAGE_BACKEND and restart.
```

**Exit codes:**
- `0`: All tables migrated successfully.
- `1`: One or more rows failed to transform or insert. Transaction for that table rolled back; earlier tables may be partially migrated. See error message for which column/table failed. Fix the row in source, then re-run execute.
- `2`: Source or target database connection failed.

### verify

**Purpose:** Confirm post-migration integrity. Compares row counts and spot-checks a sample of rows in both directions.

**Reads:** Both source and target (all rows and metadata).

**Writes:** Nothing.

**Invocation:**

```shell
node scripts/migrate-storage/cli.mjs verify \
  --from sqlite://./data/pdpp.sqlite \
  --to postgres://user:password@localhost:5432/pdpp
```

**Sample output (success):**

```
Verifying sqlite://./data/pdpp.sqlite vs postgres://user:password@localhost:5432/pdpp

Row count check (non-derived tables):
  connectors                        12 vs 12 ✓ MATCH
  oauth_clients                      4 vs 4 ✓ MATCH
  grants                           218 vs 218 ✓ MATCH
  tokens                          1843 vs 1843 ✓ MATCH
  ...
  spine_events                      0 vs 0 ✓ MATCH

Spot-check (10 random rows per table):
  connectors                         10/10 values match ✓
  oauth_clients                       4/4 values match ✓
  grants                            10/10 values match ✓
  ...

Result: ALL TABLES MATCH. Migration successful.
```

**Sample output (mismatch):**

```
Verifying sqlite://./data/pdpp.sqlite vs postgres://user:password@localhost:5432/pdpp

Row count check (non-derived tables):
  grants                           218 vs 215 ✗ MISMATCH

Spot-check (10 random rows per table):
  grants                            1/10 values differ
    Row id=42: source.expires_at='1234567890' vs target.expires_at=1234567890 (type mismatch)

Result: MISMATCH DETECTED. See details above.
```

**Exit codes:**
- `0`: All tables match (row counts and spot-check values).
- `1`: Row count mismatch or value divergence detected. Indicates partial/corrupted migration or concurrent writes during migration.
- `2`: One database unreachable.

## Recommended runbook (SQLite → Postgres)

Follow these steps in order. Each is a gate for the next.

1. **Stop PDPP.** Kill all running instances:
   ```shell
   pkill -f 'node.*server/index.js'
   ```
   Confirm no writers on the source:
   ```shell
   lsof data/pdpp.sqlite
   ```
   Should return zero results.

2. **Snapshot the source.** Preserve the original for rollback within at least a week:
   ```shell
   cp data/pdpp.sqlite data/pdpp.sqlite.bak
   ```

3. **Start Postgres container.** Use the reference docker-compose with the Postgres profile:
   ```shell
   docker compose --profile postgres --env-file .env.docker up -d postgres
   ```
   Wait for readiness:
   ```shell
   docker compose ps postgres
   ```
   Should show `(healthy)` after ~10 seconds. Inspect logs if not:
   ```shell
   docker compose logs postgres | tail -20
   ```

4. **Plan the migration.** Estimate row counts and duration:
   ```shell
   node scripts/migrate-storage/cli.mjs plan \
     --from sqlite://./data/pdpp.sqlite \
     --to postgres://user:password@localhost:5432/pdpp
   ```
   This is read-only; run as many times as needed.

5. **Diff schema compatibility.** Verify the target is empty and schemas align:
   ```shell
   node scripts/migrate-storage/cli.mjs diff \
     --from sqlite://./data/pdpp.sqlite \
     --to postgres://user:password@localhost:5432/pdpp
   ```
   Expected output: `Result: COMPATIBLE. Target is empty.`

6. **Execute migration.** Perform the actual data transfer:
   ```shell
   node scripts/migrate-storage/cli.mjs execute \
     --from sqlite://./data/pdpp.sqlite \
     --to postgres://user:password@localhost:5432/pdpp
   ```
   Tail stdout; you will see per-table progress. Typical runtime: 2–10 minutes depending on data size.

7. **Verify integrity.** Confirm row counts and spot-check values:
   ```shell
   node scripts/migrate-storage/cli.mjs verify \
     --from sqlite://./data/pdpp.sqlite \
     --to postgres://user:password@localhost:5432/pdpp
   ```
   Expected output: `Result: ALL TABLES MATCH.`

8. **Update environment.** Configure PDPP to use Postgres:
   ```shell
   # Edit .env.docker or export inline
   export PDPP_STORAGE_BACKEND=postgres
   export PDPP_DATABASE_URL='postgres://user:password@postgres:5432/pdpp'
   ```
   (If using Docker, update the compose service env or pass via `--env-file`.)

9. **Start PDPP.** Boot the reference server against Postgres:
   ```shell
   node server/index.js
   ```
   **First boot rebuilds search indexes** (lexical and semantic). This is expected and unavoidable: search index schemas differ between SQLite (sqlite-vec virtual tables) and Postgres (pgvector columns), and the runtime owns rebuilding them from `blobs` and `records`. Tail logs to confirm completion:
   ```shell
   # Watch for:
   # "Building lexical_search_index..."
   # "Building semantic_search_blob..."
   # Final log: "Search index rebuild complete. Server ready."
   ```
   Can take 30 seconds to several minutes depending on blob/record volume.

10. **Smoke test.** Verify basic operations:
    - Log in to the dashboard.
    - View a record; confirm data displays correctly.
    - Run a connector; confirm oauth_clients, grants, and tokens tables interact.
    - Check `/server/health` (if exposed); should return 200 OK.

11. **Decommission SQLite backup.** After confirming stability in production (24–48 hours):
    ```shell
    rm data/pdpp.sqlite.bak
    ```

## Reverse direction (Postgres → SQLite)

Use the same four commands with source and target swapped:

```shell
node scripts/migrate-storage/cli.mjs plan \
  --from postgres://user:password@localhost:5432/pdpp \
  --to sqlite://./data/pdpp.sqlite
```

(Proceed through diff → execute → verify as above.)

**Caveat:** Reverse migration requires the `sqlite-vec` extension to be available in the target SQLite runtime. PDPP's Node.js dependencies include `sqlite-vec`; normal startup will rebuild search indexes. If you see errors about `sqlite-vec` on first boot, verify the `sqlite-vec` npm package is installed in the reference-implementation dependencies.

## What gets migrated, what doesn't

### Migrated tables (24 non-derived)

All owner/grant/connector/ingest/scheduling/runtime state:

- `connectors` — registered connectors and metadata
- `oauth_clients` — third-party OAuth client registrations
- `grants` — user grants to connectors (scopes, expiry, refresh tokens)
- `tokens` — derived OAuth tokens; refreshed on access
- `pending_consents` — awaiting user signature/approval
- `owner_device_auth` — device enrollment state for local exporters
- `device_exporters` — remote ingest device registrations
- `device_ingest_credentials` — short-lived device tokens
- `device_enrollment_codes` — one-time codes for device bootstrap
- `device_source_instances` — per-device data source identity
- `device_ingest_batch_outcomes` — ingest result telemetry
- `source_webhook_events` — source webhook idempotency decisions
- `connector_state` — per-connector key-value store (durable config, cursor)
- `grant_connector_state` — per-grant connector runtime state
- `connector_schedules` — scheduled run timing
- `controller_active_runs` — in-flight connector runs (if persistent across restarts)
- `scheduler_run_history` — job queue history and statistics
- `scheduler_last_run_times` — scheduler checkpoints for resumption
- `version_counter` — global migration/schema versioning
- `blobs` — raw ingested data (PII, structured records)
- `blob_bindings` — record→blob relationships
- `records` — user-facing data (derived from blobs via connectors)
- `record_changes` — change log for audit and replication
- `spine_events` — event sourcing backbone (optional; depends on PDPP profile)

### Rebuilt tables (7 derived, not migrated)

These are reconstructed by the PDPP runtime on first boot after migration:

- `lexical_search_index` — full-text inverted index (FTS)
- `lexical_search_snapshots` — FTS snapshot metadata
- `lexical_search_meta` — lexical search runtime state
- `semantic_search_blob` — vector embeddings for similarity search (pgvector)
- `semantic_search_snapshots` — semantic snapshot metadata
- `semantic_search_meta` — semantic search runtime state
- `semantic_search_backfill_progress` — resumable backfill tracker

**Why?** These tables are derived from `blobs` and `records`. Their schema and generation logic differ between SQLite (sqlite-vec virtual tables) and Postgres (pgvector columns). The runtime is the source of truth for rebuilding them correctly; migrating them would risk stale or corrupt indexes. Always let the runtime rebuild.

## Failure modes and recovery

### Schema drift found by `diff`

**Symptom:** `diff` reports `COLUMN MISMATCH` or `CONSTRAINT MISMATCH` for a table.

**Cause:** Source and target schemas are incompatible (version skew, incomplete prior migration, or manual edits).

**Recovery:**
1. Identify the column and type mismatch from the error output.
2. If target is stale: drop the target database and re-bootstrap:
   ```shell
   dropdb pdpp  # or DELETE FROM <table> IF EMPTY
   node scripts/migrate-storage/cli.mjs plan --from sqlite://... --to postgres://...
   ```
3. If source is stale: ensure you are running the same PDPP version for both source and target. Upgrade the older instance and re-snapshot.
4. Re-run `diff` to confirm `COMPATIBLE`.

### Locked source database

**Symptom:** `execute` fails immediately with "database is locked" or similar.

**Cause:** A writer (PDPP server, external script, or journal lock) is still holding the SQLite file.

**Recovery:**
1. Kill all writers:
   ```shell
   pkill -f 'node.*server/index.js'
   lsof data/pdpp.sqlite  # Confirm zero results
   ```
2. Remove stale journal files if present:
   ```shell
   rm -f data/pdpp.sqlite-journal data/pdpp.sqlite-wal
   ```
3. Re-run `execute`.

### Non-empty target database

**Symptom:** `execute` fails with "target table <name> is not empty" or similar.

**Cause:** Target already contains data (partial migration, or reuse of an existing Postgres instance).

**Options:**
- **Safe:** Truncate the target and re-run:
  ```shell
  # Connect to target Postgres
  psql postgres://user:password@localhost:5432/pdpp -c "TRUNCATE connectors, oauth_clients, grants, tokens, pending_consents, owner_device_auth, device_exporters, device_ingest_credentials, device_enrollment_codes, device_source_instances, device_ingest_batch_outcomes, source_webhook_events, connector_state, grant_connector_state, connector_schedules, controller_active_runs, scheduler_run_history, scheduler_last_run_times, version_counter, blobs, blob_bindings, records, record_changes, spine_events CASCADE;"
  ```
  Then re-run `execute`.
- **Risky (if you know what you're doing):** Pass `--allow-non-empty` to `execute` and accept the risk of mixing old and new data:
  ```shell
  node scripts/migrate-storage/cli.mjs execute \
    --from sqlite://./data/pdpp.sqlite \
    --to postgres://user:password@localhost:5432/pdpp \
    --allow-non-empty
  ```
  This should only be used if you are certain the target contains compatible data and you want to merge.

### Single-row failure during `execute`

**Symptom:** `execute` halts with "Row transform error in table <name> column <column>: <reason>" after migrating some tables.

**Cause:** A row's value cannot be coerced to the target type (e.g., invalid JSON in a JSONB column, non-integer in BIGINT).

**Recovery:**
1. Note the table and column from the error.
2. Inspect the problematic row in source:
   ```shell
   sqlite3 data/pdpp.sqlite "SELECT * FROM <table> WHERE <column> IS NOT NULL LIMIT 10;"
   ```
3. Fix the row in source (e.g., validate JSON, parse string to integer).
4. Truncate the target table that failed and all dependents, or truncate the entire target (safer):
   ```shell
   psql ... -c "TRUNCATE <table> CASCADE;"
   ```
5. Re-run `execute`. The migration is restartable; tables that succeeded will insert again (Postgres will handle duplicates or you may need to TRUNCATE CASCADE first).

### First-boot rebuild taking forever

**Symptom:** PDPP starts, begins rebuilding search indexes, and appears hung (no log output for 10+ minutes) or consumes 100% CPU.

**Cause:** Search index rebuild is genuinely slow with large blobs/records tables, or pgvector/sqlite-vec extension is missing.

**Recovery:**
1. Confirm the extension is installed:
   ```shell
   # For Postgres
   psql postgres://user:password@localhost:5432/pdpp -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname = 'vector';"
   # Should return 'vector'
   ```
2. Check logs for errors:
   ```shell
   tail -100 logs/pdpp.log  # or docker compose logs pdpp
   ```
   If you see "vector extension not found" or "sqlite-vec not available", install it:
   - **Postgres:** Use a pgvector-enabled image (e.g., `pgvector/pgvector:pg16`).
   - **SQLite:** Ensure `sqlite-vec` npm package is in node_modules; if not, `npm install sqlite-vec`.
3. If the index build is just slow, wait. Log output will show progress (e.g., "Building lexical_search_index: 1000/18420 rows..."). Typical rates: 1000–5000 rows/second depending on hardware.

### U+0000 and other binary leaks in legacy records

**Symptom:** `execute` halts on the `records` table (or any table with a JSONB column) with `coerceJsonb: forbidden U+0000 in JSONB string in table "<table>" column "<col>" (json_path "<pointer>"). Use --jsonb-nul-policy=migrate-to-blobs ...`.

**Cause:** Postgres JSONB cannot store the U+0000 (NUL) byte inside a JSON string value (SQLSTATE 22P05). SQLite was permissive about it. Connectors that pre-date the `safe-text-preview.ts` fix (see `packages/polyfill-connectors/src/safe-text-preview.ts`) sometimes wrote raw command output or other binary content directly into preview/snippet/body fields, so a legacy SQLite database may contain records that Postgres will reject. New writes from current connectors will **never** hit this — every text-bearing field is now branded `pdppSafeText` and routed through `safeTextPreview()`. This safety net exists only to migrate legacy state.

**Recovery: choose a `--jsonb-nul-policy`.** The migrate-storage CLI accepts `--jsonb-nul-policy <mode>` (default `strict`) on every command:

| mode | what it does | when to use |
|---|---|---|
| `strict` (default) | Throw a descriptive error on the first offending value, naming the table, column, RFC 6901 JSON Pointer, and offset. The migration aborts before any partial write is committed for the failing table. | New/clean installs, CI, and any time you want to be loud about an unexpected binary leak. |
| `migrate-to-blobs` | Extract the offending string's UTF-8 bytes into the `blobs` table (idempotent on sha256), set the leaf in `record_json` to `null`, and record the JSON Pointer in `blob_bindings.json_path`. **Lossless** — the bytes are recoverable from `blobs` via the standard content-addressed mechanism. Produces records structurally indistinguishable from a record emitted by a correctly-fixed connector. | **Recommended for migrating legacy SQLite DBs.** Use this when migrating data captured before the `safeTextPreview`/`pdppSafeText` rollout. |

The previous `scrub` and `preserve-base64` policies have been removed. `scrub` was silent corruption; `preserve-base64` inlined binary back into JSONB (relocating rather than fixing the violation). Both contradicted the protocol invariant; see `docs/reference/binary-content-invariant-design-brief.md` §4.2 for the full reasoning.

**Extraction ledger.** With `migrate-to-blobs`, the migration writes one JSONL line per extracted leaf to `./pdpp-data/migration-extractions.jsonl` (override with `--ledger <path>`). Each line:

```json
{
  "timestamp": "2026-05-11T18:42:13.421Z",
  "connector_id": "codex",
  "stream": "function_calls",
  "record_key": "call_Zo6lUkiLFm6lSBfl7smSwtNo",
  "json_path": "/output_preview",
  "sha256": "f3a1c9b2…",
  "original_byte_length": 4823,
  "reason": "U+0000 at offset 342"
}
```

The ledger is **redundant with canonical DB state**, not a substitute for it. Canonical state for the field-to-blob mapping lives in `blob_bindings` (the `json_path` column). The ledger is an operational artifact useful for audit, replay, and "what got rewritten?" queries. After migration you can:

- Count affected records: `wc -l pdpp-data/migration-extractions.jsonl`
- Per-connector breakdown: `jq -r '.connector_id' pdpp-data/migration-extractions.jsonl | sort | uniq -c`
- Recover any blob via SQL: `SELECT data FROM blobs WHERE sha256 = '...'`

**Execute summary** (example):

```
Migration complete: 4,812,309 rows in 412.04s [jsonb-nul-policy=migrate-to-blobs]
  Extracted 131 binary leaves to blobs (47 unique sha256s, 8.20 MB) from 131 rows.
  Extraction ledger: ./pdpp-data/migration-extractions.jsonl
  Post-migration verifier: PASS (binary-content invariant holds).
```

**Usage on a legacy DB:**

```shell
# Plan and diff are safe to run with any policy.
node scripts/migrate-storage/cli.mjs plan \
  --from .pdpp-data/pdpp.sqlite \
  --to "postgres://user:password@localhost:5432/pdpp"

# Dry-run to preview extraction scope without writing anything.
node scripts/migrate-storage/cli.mjs execute \
  --from .pdpp-data/pdpp.sqlite \
  --to "postgres://user:password@localhost:5432/pdpp" \
  --jsonb-nul-policy migrate-to-blobs \
  --dry-run

# Lossless migration of legacy records. Verifier runs automatically at the end.
node scripts/migrate-storage/cli.mjs execute \
  --from .pdpp-data/pdpp.sqlite \
  --to "postgres://user:password@localhost:5432/pdpp" \
  --jsonb-nul-policy migrate-to-blobs \
  --ledger .pdpp-data/migration-extractions.jsonl

# Standalone re-verification (e.g., after any out-of-band write).
node scripts/migrate-storage/cli.mjs verify \
  --from .pdpp-data/pdpp.sqlite \
  --to "postgres://user:password@localhost:5432/pdpp"
```

### Downstream consumer audit (migration safety)

After migration, the 131 (or however many) affected records have `record_json` fields that are `null` where they previously contained binary content. We audited the three highest-leverage consumer paths to confirm they handle this honestly:

1. **`primary_key_text` derivation** (`reference-implementation/server/postgres-records.js:202`) — uses `COALESCE(record_json->>'<primary_field>', record_key)`. When the primary field is null, falls back to `record_key`. Records remain uniquely identifiable. ✓
2. **FTS5 / lexical indexing** (`reference-implementation/server/search.js:225`) — explicit `if (typeof value !== 'string' || value.length === 0) continue;` guard. Null fields are skipped (no garbage indexed). ✓
3. **API serialization** (`reference-implementation/server/postgres-records.js:140`) — projects `record_json` directly; nulls pass through to the wire and clients see `null` rather than corrupted bytes. ✓

A consumer that needs to recover the original bytes joins `blob_bindings` on `(connector_id, stream, record_key, json_path)`. The bytes are addressable by sha256 in the `blobs` table — see the design brief §4.8 for the exact SQL.

After migration, a `null` value in `record_json` may now mean **one of three things**: (a) the field was absent in the source, (b) the field was empty, or (c) the field was extracted to a blob. Where this distinction matters, the disambiguator is a `blob_bindings` join filtered on `json_path`. The dashboard's record-detail view will fall into case (c) only for the migrated records; new records emitted by current connectors never produce case (c).

### Post-migration verifier

`execute` automatically runs a verifier as its final step, asserting three invariants on the target Postgres DB:

1. **No string leaf in any `record_json` contains forbidden codepoints** (U+0000, non-whitelisted C0/C1 controls, DEL). This is the binary-content invariant — see `docs/reference/binary-content-invariant-design-brief.md` §4.1.
2. **Every `blob_bindings` row with a JSON-Pointer `json_path` (i.e., not `@record`) references a leaf that is `null` in `records.record_json`.** A non-null leaf would mean the extraction missed a value or a write reintroduced it.
3. **Every `blob_bindings.blob_id` exists in `blobs`.** Dangling bindings indicate a partial extraction.

The verifier is mandatory; `execute` exits with code 3 if any invariant fails. You can also run it standalone with `verify`, which is safe against a live target DB.

**Upstream fix.** The underlying invariant is enforced at two layers in the connector package:

- `packages/polyfill-connectors/src/safe-text-preview.ts` — the parse-time helper that decides "text vs. binary" and returns the precise reason a value was rejected.
- `packages/polyfill-connectors/src/pdpp-safe-text.ts` — the branded Zod schema (`pdppSafeText`) every text-bearing connector field uses. A connector that bypasses `safeTextPreview` and tries to assign bytes to a text field gets caught by schema validation with a precise error.

After migration, you should not need any policy other than `strict` ever again — and `strict` is exactly what catches a regression early.

## Why CLI-only, not a UI button

**Convention:** Destructive migrations (especially across database systems) belong in the operator's CLI toolbox, not in a running web interface. The running PDPP server is the wrong place to launch a migration that requires the server to be stopped.

**Prior art:** Heroku's `pg:copy` (data transfer between Postgres databases), pgloader (schema + data migration), and Supabase's `db push` (local schema to cloud) all follow this pattern: CLI-driven, server stopped, explicit confirmation.

**UI surface (planned):** The PDPP dashboard's Settings → Storage pane will display the current backend (SQLite or Postgres) and a read-only connection status. It will provide a pre-filled CLI invocation (with your current connection strings) that you copy-paste into your terminal. This preserves the safety principle (CLI only, server stopped) while reducing copy-paste friction.

## Troubleshooting

**Q: Can I test migration without stopping PDPP?**
A: Yes. Run `plan` and `diff` while the server is running; they are read-only. Do not run `execute` with a live server.

**Q: What if execute fails halfway?**
A: Transactions roll back per table. Earlier tables are committed; the failed table is rolled back. Restart from step 6 of the runbook (re-run `execute`). It is safe to retry; duplicate inserts will fail on PK constraint but will not corrupt data.

**Q: Can I migrate between two running Postgres instances?**
A: Yes. The migration tool is source/target agnostic (SQLite, Postgres, or theoretically any compatible database). Swap the connection strings and follow the same runbook.

**Q: How long does the rebuild take?**
A: Search index rebuild speed depends on blob/record volume and hardware:
- 1,000 blobs: < 10 seconds
- 10,000 blobs: 30 seconds to 2 minutes
- 100,000+ blobs: 5–30 minutes
- With 10+ Gbps network: faster; constrained by CPU and disk I/O.
Watch the logs; there is no safe way to skip the rebuild.

**Q: Can I keep both SQLite and Postgres in sync?**
A: Not without external tooling (e.g., a trigger/replication system). The migration is one-way and destructive. Once you switch `PDPP_STORAGE_BACKEND=postgres`, retire the SQLite DB.

**Q: What if my Postgres instance dies mid-migration?**
A: Same as execute failure: fix the Postgres instance, re-run `execute` from step 6. Succeeded tables are committed; failed table is rolled back and can be retried.
