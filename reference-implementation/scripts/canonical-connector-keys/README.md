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
| `verify-backup-restore.mjs` | §3.4 post-migration STORAGE-layer assertions (SQL joins, JSONB ids, row counts) against a live DB. |
| `verify-http-surfaces.mjs` | §3.4 post-migration LIVE HTTP READ-PATH assertions. Boots the reference app in-process against the migrated restore and checks owner record hydration (canonical key + stale-URL alias / Decision 8), single reads, `/v1/search`, owner dashboard connection hydration (`/v1/owner/connections`), and grant-package membership (`/_ref/grant-packages`). **Seed-specific** (hard-codes the synthetic seed's ids/counts/owner) — do NOT run against production data. |
| `verify-production-invariants.mjs` | §3.4 **DATA-AGNOSTIC** post-migration assertions for the owner-run production gate. Asserts only structural invariants true for ANY dataset: zero non-canonical stragglers in active `connector_id` columns and active JSONB surfaces, all `connectors` rows canonical, and row-count parity vs a `--before` snapshot (`connectors` may shrink via parent collapse, never grow). This is the verifier the owner runs against a restore of their own production backup. |
| `verify-production-invariants.test.mjs` | Deterministic unit coverage for the data-agnostic verifier's straggler predicate, incl. the guard that valid CUSTOM connector keys are NOT flagged (no DB; run via `node --test`). |
| `seed-real-manifests.mjs` | Overwrites the seed's thin connector manifests with the real first-party manifests before the dump, so the HTTP read path can resolve streams. |
| `run-backup-restore-validation.sh` | §3.4 restore→migrate→verify(SQL)→verify(HTTP) harness (below). |
| `fixtures/backup-restore-seed.sql` | Pre-migration seed for the §3.4 harness (incl. the device-flow `oauth_clients` row the HTTP verifier needs to mint an owner token). |
| `verify-http-surfaces.test.mjs` | Deterministic unit coverage for the HTTP verifier's pure helpers + seed-coverage contract (no DB; run via `node --test`). |

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
9. `verify-backup-restore.mjs` asserts the §3.4 STORAGE-layer invariants (SQL).
9b. `verify-http-surfaces.mjs` boots the reference app in-process against the
   migrated restore and asserts the §3.4 LIVE HTTP READ-PATH invariants — owner
   record hydration under the canonical key AND via the stale URL-shaped id
   (Decision 8), single-record reads, `/v1/search`, owner dashboard connection
   hydration, and grant-package membership, all with no registry URL in
   owner-visible payloads, no human in a browser.
10. `cli.mjs write --apply` a second time — proves idempotency (no rewrites).
11. `cli.mjs write --apply --include-backup-tables` — proves backup-tier rows are rewritten only under explicit opt-in.
12. Drops both disposable databases.

Step 3 additionally patches the real first-party manifests into the seed
(`seed-real-manifests.mjs`) before the dump, so the restored connector catalog
carries valid operational manifests the HTTP read path can resolve.

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

Last full run: **38/38 storage checks + 15/15 HTTP checks + idempotency + backup-tier opt-in passed**.

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
- backup-tier tables rewritten only when `--include-backup-tables` is explicitly passed;
- the migration is idempotent;
- **the LIVE HTTP read path** (booted app, not SQL): owner record reads hydrate
  the migrated rows under the canonical key AND when the owner sends the stale
  URL-shaped `connector_id` (Decision 8); single-record reads, `/v1/search`,
  owner dashboard connection hydration (`/v1/owner/connections`), and
  grant-package membership (`/_ref/grant-packages`) all resolve with NO registry
  URL in owner-visible payloads — no human in a browser.

**Does NOT prove** (the one residual that is inherently live/owner-gated):
- The seed is a representative *synthetic* fixture, not a dump of a real
  operator deployment's row volume or every connector permutation in
  production. It uses the real **schema** but author-controlled **data**.

A real operator sign-off therefore still requires running this same cycle
against a restore of the operator's **own production backup**. The
step-by-step owner runbook is
`docs/operator/canonical-connector-keys-production-restore-packet.md`. It uses
the **data-agnostic** `verify-production-invariants.mjs` (not the seed-specific
SQL/HTTP verifiers, which assert synthetic values) plus `inspect` + `write` +
an idempotency re-run, all against a disposable restore. The remaining owner
step is supplying real production-shaped data and, where the operator wants
belt-and-suspenders, a hosted-`/mcp` package read spot check against the live
deployment (the bearer-rejecting `/mcp` and package token paths are exercised
separately by tasks 5.x / 7.4).
