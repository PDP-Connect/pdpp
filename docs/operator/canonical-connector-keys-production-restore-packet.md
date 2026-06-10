# Canonical connector-key migration — production-backup restore packet

Audience: the operator (owner) running the final sign-off for OpenSpec change
`canonicalize-connector-keys` **task 3.4**.

Status of the task before this run: every layer is proven against the **real
reference schema with synthetic data** by the no-human harness
`reference-implementation/scripts/canonical-connector-keys/run-backup-restore-validation.sh`
(last run: **38/38 SQL + 15/15 HTTP + 17/17 data-agnostic invariants +
idempotency + backup-tier opt-in**). The single remaining gate is running the
**same restore → migrate → verify cycle against a restore of the operator's own
production backup**. This packet makes that run mechanical.

This is the **only destructive-capable step** in the canonical-keys work. It is
designed so that, executed verbatim, it cannot touch live production data.

---

## 0. The one rule

**Every command in this packet runs against a DISPOSABLE database restored from
a backup. Never point any `write --apply` command at the live production
database.** The migration is transactional and idempotent, but the discipline
here is: prove it on a throwaway restore first, then (separately, on the
operator's own change-control terms) decide whether to apply to live.

If `inspect` reports any unmapped value in an **active** tier, **stop**. Do not
pass `--allow-unmapped` to force the write. Resolve the mapping first (see
§7 Troubleshooting).

---

## 1. What this proves vs. what the harness already proved

| Layer | Proven by the no-human harness (synthetic data) | Proven by THIS packet (your production data) |
|---|---|---|
| Real table set / schema | yes (`pg_dump --schema-only` of the live ref DB) | yes (your backup carries your schema) |
| Storage-layer invariants (SQL) | yes, seed-specific assertions | yes, **data-agnostic** invariants (`verify-production-invariants.mjs`) |
| Live HTTP read path | yes, seed-specific (`verify-http-surfaces.mjs`) | spot-check on real data (§5) |
| Real production row volume / connector permutations | **no** | **yes** |

The seed-specific verifiers (`verify-backup-restore.mjs`,
`verify-http-surfaces.mjs`) hard-code the synthetic seed's grant ids, record
counts, owner subject, and streams. **Do not run them against production data —
they will fail on values they were never given.** The production gate uses the
data-agnostic verifier instead.

---

## 2. Inputs and environment variables

Collect these before starting. None are printed by the tooling; keep the
connection string out of your shell history (`HISTCONTROL=ignorespace` + leading
space, or `read -s`).

| Variable | Meaning | Example / how to get it |
|---|---|---|
| `PROD_BACKUP` | Path to the production Postgres dump to restore. **A copy/export, not the live DB.** | `pg_dump -Fc` of production, or your existing backup artifact |
| `PG_CONTAINER` | Local Postgres container name (if restoring inside the reference stack) | `pdpp-postgres-1` (default) |
| `PG_USER` | Postgres role for the disposable DB | `pdpp` (default) |
| `RESTORED_DB` | Name of the **disposable** database you restore into | `pdpp_cck_prodcheck` |
| `PDPP_DATABASE_URL` | Connection string to the **restored disposable DB only** | `postgres://pdpp:***@127.0.0.1:55432/pdpp_cck_prodcheck` |
| `PDPP_STORAGE_BACKEND` | Required by the CLI; must be `postgres` | `postgres` |
| `OWNER_SUBJECT` | (HTTP spot-check only) an owner subject id present in your data, to mint an owner token | your production owner's `subject_id` |

`RESTORED_DB` must be a simple SQL identifier (`^[A-Za-z_][A-Za-z0-9_]*$`). Pick a
name that is obviously disposable and unmistakable for production.

---

## 3. Safe local dry-run validation (no production data) — do this FIRST

Before touching any production backup, confirm the tooling is green on this
machine. This uses only synthetic data and disposable databases.

```bash
# (a) unit suites — no DB, deterministic
cd reference-implementation
node --test \
  scripts/canonical-connector-keys/inspect.test.mjs \
  scripts/canonical-connector-keys/writer.test.mjs \
  scripts/canonical-connector-keys/verify-http-surfaces.test.mjs \
  scripts/canonical-connector-keys/verify-production-invariants.test.mjs
# expect: pass 77+ / fail 0

# (b) full synthetic restore→migrate→verify harness (needs the stack up:
#     scripts/reference-stack.sh up). Creates and drops disposable DBs.
cd ..
reference-implementation/scripts/canonical-connector-keys/run-backup-restore-validation.sh
# expect: 38/38 SQL + 15/15 HTTP + 17/17 data-agnostic invariants
#         + idempotency + backup-tier opt-in, then "ALL §3.4 STEPS PASSED"
```

If either fails on unmodified `main`, **stop and report** — the production run
is not yet safe to attempt.

---

## 4. Owner-only production backup validation

> Everything below operates on `RESTORED_DB`, the disposable restore. Production
> is never a target.

### 4.1 Restore the production backup into a disposable database

Restore **inside the container** so the DB password never reaches host logs. The
following mirrors what the synthetic harness does in steps 6–8, but against your
backup.

```bash
PG_CONTAINER=pdpp-postgres-1
PG_USER=pdpp
RESTORED_DB=pdpp_cck_prodcheck

# Copy your production dump into the container (adjust source path):
docker cp "$PROD_BACKUP" "$PG_CONTAINER:/tmp/prod-backup.dump"

# Create the disposable DB and restore into it.
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $RESTORED_DB WITH (FORCE);"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "CREATE DATABASE $RESTORED_DB;"
docker exec "$PG_CONTAINER" sh -c \
  "pg_restore -U $PG_USER -d $RESTORED_DB --no-owner --no-privileges /tmp/prod-backup.dump" 2>&1 | tail -3
docker exec "$PG_CONTAINER" sh -c "rm -f /tmp/prod-backup.dump"
```

Build the host connection string to the restored DB (mapped port shown for the
reference stack; adjust if different). Use a leading space so it stays out of
shell history:

```bash
 export PDPP_STORAGE_BACKEND=postgres
 export PDPP_DATABASE_URL="postgres://$PG_USER:<password>@127.0.0.1:55432/$RESTORED_DB"
```

### 4.2 Capture the before-snapshot of row counts

This snapshot is what the data-agnostic verifier compares against to prove no
rows are dropped or duplicated. Capture counts for the tables the migration
touches. Run inside the container (no host logging of the URL):

```bash
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$RESTORED_DB" -tAc "
  SELECT json_object_agg(t, n) FROM (
    SELECT 'connectors' t, COUNT(*) n FROM connectors
    UNION ALL SELECT 'connector_instances', COUNT(*) FROM connector_instances
    UNION ALL SELECT 'records', COUNT(*) FROM records
    UNION ALL SELECT 'record_changes', COUNT(*) FROM record_changes
    UNION ALL SELECT 'version_counter', COUNT(*) FROM version_counter
    UNION ALL SELECT 'connector_state', COUNT(*) FROM connector_state
    UNION ALL SELECT 'blobs', COUNT(*) FROM blobs
    UNION ALL SELECT 'blob_bindings', COUNT(*) FROM blob_bindings
    UNION ALL SELECT 'scheduler_run_history', COUNT(*) FROM scheduler_run_history
    UNION ALL SELECT 'grants', COUNT(*) FROM grants
    UNION ALL SELECT 'grant_packages', COUNT(*) FROM grant_packages
    UNION ALL SELECT 'grant_package_members', COUNT(*) FROM grant_package_members
    UNION ALL SELECT 'pending_consents', COUNT(*) FROM pending_consents
  ) s;" > /tmp/cck-prod-before.json
cat /tmp/cck-prod-before.json
```

If your deployment has additional `connector_id`-bearing active tables, add them
here; the verifier checks every table named in this snapshot.

### 4.3 Dry-run (read-only) — fail closed on unmapped active values

```bash
node reference-implementation/scripts/canonical-connector-keys/cli.mjs inspect
```

- Exit code **0** and a report showing rewrites with **0 unmapped active rows** →
  proceed.
- Exit code **1** ("unmapped connector_id rows in active tables") → **STOP**.
  See §7. Do **not** pass `--allow-unmapped` with `--apply`.

The dry-run is SELECT-only and writes nothing.

### 4.4 Apply the migration (transactional, on the disposable restore)

```bash
node reference-implementation/scripts/canonical-connector-keys/cli.mjs write --apply
```

- The command runs `inspect` again internally and refuses to write if active
  tables still hold unmapped values.
- All writes happen in a single transaction with before/after row-count
  assertions; any mismatch rolls back the whole migration.
- Backup-tier tables (`backup_*`, `compact_*_backup_*`, `fix_*`, `mig_*`) are
  **not** rewritten unless you explicitly add `--include-backup-tables`. Scratch
  (`cleanup_*`) tables are never rewritten.

### 4.5 Verify data-agnostic invariants (SQL)

```bash
node reference-implementation/scripts/canonical-connector-keys/verify-production-invariants.mjs \
  --before /tmp/cck-prod-before.json
```

Asserts, for **any** dataset:
- no non-canonical (`https://…` / legacy alias / `local-device:`-wrapped /
  malformed) connector id remains in any **active** `connector_id` column;
- the same for every **active** JSONB-embedded connector id (the four surfaces
  the migration rewrites);
- every `connectors` row carries a canonical key;
- row counts preserved on every table in the before-snapshot — **except**
  `connectors`, which may legitimately **shrink** (never grow) when two
  pre-migration ids collapse into one canonical parent (e.g. a URL-shaped
  `gmail` row and a bare `gmail` row).

Expect `N/N checks passed`, exit 0.

### 4.6 Idempotency — second apply must rewrite nothing

```bash
node reference-implementation/scripts/canonical-connector-keys/cli.mjs write --apply --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const x=r.applied?.applied??r.applied;const c=x?.columns?.length??-1;const j=(x?.jsonb??[]).reduce((a,k)=>a+(k.rowsUpdated||0),0);console.log(`second-run rewrites: columns=${c} jsonb=${j}`);process.exit(c===0&&j===0?0:1);});'
```

Expect `columns=0 jsonb=0`, exit 0.

---

## 5. Owner dashboard / HTTP read spot-check (optional but recommended)

The data-agnostic verifier proves the storage layer. To also prove the running
app hydrates migrated production-shaped data over HTTP, boot the reference app
against the restored+migrated disposable DB and read as the owner. Two options:

**Option A — code-driven, no browser** (reuses the HTTP verifier's boot but
expect seed-specific record-count assertions to fail; read it for the
*hydration / no-URL-leak* signal, not the counts):
This is **not** recommended for production data because its expectations are
seed-shaped. Prefer Option B.

**Option B — manual surface smoke** (the task 7.3 surfaces against migrated
production-shaped data): point a local reference app at `PDPP_DATABASE_URL` and,
authenticated as the owner, confirm:
- `/dashboard` and `/dashboard/explore` render connections under canonical names
  with **no registry URL** visible;
- `/dashboard/event-subscriptions` and `/dashboard/deployment/tokens` load;
- a record read returns content (records hydrate under the canonical key);
- grant packages resolve their child grants.

**Fail signature to watch for:** `connection_not_found` on owner or grant-scoped
reads post-migration — that is the canonical read-path symmetry bug class
(design Decision 8). If it appears, the migration left a read path keyed on a
stale id; capture the surface and stop.

Do not screenshot or copy real record contents or owner PII. Report pass/fail
per surface only.

---

## 6. Evidence to collect (no secrets)

Capture, for the report, **only** these — never the connection string, record
bodies, tokens, cookies, or owner PII:

- `inspect` summary: distinct mapped values, **0 unmapped active**.
- `verify-production-invariants.mjs` output: `N/N checks passed`, including the
  per-table row-count lines (counts are aggregate integers, not data).
- Idempotency line: `columns=0 jsonb=0`.
- Spot-check (§5): pass/fail per surface, and explicit "no registry URL visible".
- The fact that the disposable DB was dropped at the end (§8).

---

## 7. Troubleshooting — `inspect` reports unmapped active values

This means a connector id in an active table is neither a known first-party
shape nor a valid custom connector key. Causes and resolutions:

- **A custom/third-party connector** whose manifest never declared a
  `connector_key`. Per design §3, the migration will not silently promote an
  unknown URL into a first-party slug. Resolution: add the custom connector's
  canonical key to its manifest (or extend the allowlist if it is genuinely
  first-party), re-run from a fresh restore.
- **A new first-party connector** added since the allowlist was last updated.
  Resolution: add it to `FIRST_PARTY_CONNECTOR_KEYS` in
  `reference-implementation/server/connector-key.js` (a deliberate code change,
  not an `--allow-unmapped` bypass), re-run the local dry-run (§3), then re-run.
- **Genuinely malformed data** (a document URL, a delimiter-form id, whitespace).
  Resolution: investigate the row by primary key; this is a data-quality finding
  that predates the migration. Do not force the write.

`--allow-unmapped` is a review/diagnostic flag only. It must **never** be paired
with `--apply` on production-derived data.

---

## 8. Abort / cleanup

```bash
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $RESTORED_DB WITH (FORCE);"
rm -f /tmp/cck-prod-before.json
unset PDPP_DATABASE_URL PDPP_STORAGE_BACKEND
```

The migration on the disposable restore has no effect on production. Applying to
live production (if the operator chooses to) is a separate change-control
decision outside this validation packet; this packet only proves the migration
is correct against production-shaped data.

---

## 9. What Codex can accept after this run

Codex may check OpenSpec task 3.4 as complete **only** when the operator reports
all of the following from a run against a restore of the **real production
backup** (not the synthetic seed):

1. `cli.mjs inspect` on the restored production data: **0 unmapped active rows**
   (or, if any appeared, they were resolved via §7 and a clean re-run followed —
   never via `--allow-unmapped --apply`).
2. `cli.mjs write --apply` succeeded (single transaction, no rollback).
3. `verify-production-invariants.mjs --before <snapshot>`: **all checks passed**,
   including row-count preservation (with `connectors` allowed to shrink, never
   grow) and zero non-canonical stragglers in active columns and JSONB.
4. Idempotent second `write --apply`: **columns=0 jsonb=0**.
5. The §5 HTTP spot-check (Option B): owner dashboard hydrates, records read,
   grant packages resolve, **no registry URL visible**, **no
   `connection_not_found`**.
6. The disposable restore was dropped; no secrets/PII in the evidence.

If any of 1–5 fails, the box stays unchecked and the failure is captured as a
finding. Codex must not accept the synthetic-harness pass (already green) as a
substitute for the production-data run — that distinction is the entire residual
of task 3.4.

---

## Related

- `reference-implementation/scripts/canonical-connector-keys/README.md` — harness internals.
- `docs/operator/live-proof-packet.md` Gate 7 — the one-paragraph index entry that points here.
- `openspec/changes/canonicalize-connector-keys/tasks.md` §3.4 — the box this run closes.
- `openspec/changes/canonicalize-connector-keys/design.md` Decision 8 — the read-path canonicalization the §5 spot-check guards.
