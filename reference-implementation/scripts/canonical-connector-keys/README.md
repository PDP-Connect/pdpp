# canonical-connector-keys migration scripts

Migration tooling for the OpenSpec change `canonicalize-connector-keys`
(tasks §3.2–§3.4). Rewrites every active connector identifier from
URL-shaped / legacy-alias / `local-device:`-wrapped forms to the bare
canonical `connector_key`.

## Files

| File | Purpose |
|------|---------|
| `inspect.mjs` | Read-only dry-run (§3.2). Discovers every `connector_id` column via `information_schema`, classifies each distinct value, walks the four JSONB surfaces that embed connector ids, and tiers tables as `active`/`backup`/`scratch`. Fails closed on unmapped active values. |
| `writer.mjs` | Write migration (§3.3). Builds a plan from the inspection report and applies it inside a single transaction (column rewrites + JSONB rewrites + `connectors` parent collapse), with before/after row-count assertions and rollback on any mismatch. |
| `cli.mjs` | `inspect` and `write [--apply]` commands. |
| `inspect.test.mjs`, `writer.test.mjs` | Fixture-backed unit tests (synthetic driver) for the classification and rewrite logic, transactional rollback, row-count parity, and idempotency. |
| `verify-backup-restore.mjs` | §3.4 post-migration assertions against a live DB. |
| `run-backup-restore-validation.sh` | §3.4 restore→migrate→verify harness (below). |
| `fixtures/backup-restore-seed.sql` | Pre-migration seed for the §3.4 harness. |

## §3.4 backup/restore validation harness

`run-backup-restore-validation.sh` proves the write migration preserves
**row counts, grants, data, and record hydration** when run against a
*restored backup* — exercising restore + migrate, not just an in-place
fixture mutation.

### What it does

1. Creates a disposable `pdpp_cck_seed` database on the running Postgres
   container.
2. Loads the **real reference schema** (`pg_dump --schema-only` of the
   live reference DB) — so the harness runs against the actual table set,
   including the real `backup_*` / `cleanup_*` / `compact_*_backup_*` /
   `fix_*` / `mig_*` tiers the surface classifier was built for.
3. Seeds pre-migration rows spanning every identity shape the migration
   must handle:
   - URL-shaped first-party id (`https://registry.pdpp.org/connectors/gmail` → `gmail`)
   - legacy snake_case alias (`claude_code` → `claude-code`)
   - wrapped local-device storage form (`local-device:codex:cin_…` → `codex`)
   - already-canonical id (`spotify`, must NOT be rewritten)
   - JSONB-embedded ids across `grants.grant_json`,
     `grants.storage_binding_json`, `grant_package_members.source_json`,
     `pending_consents.params_json`
   - a `backup_*`-tier table holding a URL id (must NOT be rewritten)
4. Captures per-table row counts (the "before" snapshot).
5. `pg_dump -Fc` the seed DB → **this is the backup**.
6. `pg_restore` into a fresh `pdpp_cck_restored` DB → **restore the backup**.
7. `cli.mjs inspect` the restored DB (reports rewrites, 0 unmapped active).
8. `cli.mjs write --apply` against the restored DB.
9. `verify-backup-restore.mjs` asserts the §3.4 invariants.
10. `cli.mjs write --apply` a second time — proves idempotency (no rewrites).
11. Drops both disposable databases.

Database admin + dump/restore run **inside the container** so the DB
password never reaches host logs. The migration CLI and verifier run on
the host against the mapped port `127.0.0.1:55432`; any connection
string in output is redacted.

### Running it

Requires the reference stack up (`scripts/reference-stack.sh up`) and
reference-implementation node deps installed (`pnpm install --filter
./reference-implementation`, needed for the `pg` driver).

```bash
reference-implementation/scripts/canonical-connector-keys/run-backup-restore-validation.sh
```

Last full run: **38/38 verification checks + idempotency passed**.

### What this harness proves vs. what it does not

**Proves** (on a restored backup carrying the real schema):
- row counts preserved on every touched table;
- every active-tier `connector_id` column and JSONB-embedded id is the
  bare canonical key post-migration; zero URL/legacy/wrapped stragglers;
- grants and grant-package membership preserved with canonical ids inside
  the JSONB, unrelated fields (`connection_id`) untouched;
- records hydrate under the canonical key and join their instances; record
  payloads, version counters, blob bindings intact;
- backup-tier tables left untouched by default;
- the migration is idempotent.

**Does NOT prove** (residual for a real operator-backup run):
- The seed is a representative *synthetic* fixture, not a dump of a real
  operator deployment's row volume or every connector permutation in
  production. It uses the real **schema** but author-controlled **data**.
- It does not exercise the live owner dashboard / MCP read path against
  the migrated DB; it asserts storage-layer hydration via SQL joins, not
  HTTP read surfaces.

A real operator sign-off still requires running
`cli.mjs write --apply` against a restore of the operator's own backup and
spot-checking the owner dashboard, grant-package membership, and record
reads in the running app — exactly the §7.3 surface smoke, but against
migrated production-shaped data.
