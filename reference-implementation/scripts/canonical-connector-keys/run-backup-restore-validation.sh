#!/usr/bin/env bash
#
# canonical-connector-keys / run-backup-restore-validation.sh
#
# §3.4 validation harness: prove the canonical connector-key write
# migration preserves row counts, grants, data, and record hydration
# when run against a *restored backup* — not just an in-place fixture
# mutation.
#
# Flow (all against a DISPOSABLE database; the live reference DB is never
# touched):
#
#   1. create  pdpp_cck_seed       on the running Postgres container
#   2. load    the REAL reference schema (pg_dump --schema-only of the
#              live reference DB) into the seed DB
#   3. seed    pre-migration rows with URL-shaped ids, legacy aliases,
#              wrapped local-device storage forms, JSONB-embedded ids,
#              canonical-already rows, and a backup-tier table
#   4. capture per-table row counts (the "before" snapshot)
#   5. pg_dump the seed DB (custom format)  ==>  this IS the backup
#   6. pg_restore into a fresh pdpp_cck_restored DB  ==> restore the backup
#   7. inspect (dry-run) the restored DB  — must report rewrites, no
#      unmapped active rows
#   8. write --apply the migration against the restored DB
#   9. verify post-migration invariants (verify-backup-restore.mjs)
#  10. write --apply AGAIN — idempotency: second run must be a no-op plan
#  11. drop both disposable DBs
#
# The migration CLI + verifier run on the HOST and connect through the
# container's mapped port (127.0.0.1:55432). DB admin + dump/restore run
# INSIDE the container so the database password never reaches host logs.
#
# Requirements: a running pdpp-postgres-1 container (reference stack up),
# host `node` with reference-implementation deps installed (for `pg`),
# host `psql`/`pg_dump` not required (in-container tools are used).
#
# Usage:
#   reference-implementation/scripts/canonical-connector-keys/run-backup-restore-validation.sh
#
# Env overrides:
#   PG_CONTAINER   (default pdpp-postgres-1)
#   PG_HOST_PORT   (default 55432)
#   LIVE_DB        (default pdpp_proof)  — source of the real schema
#   SEED_DB        (default pdpp_cck_seed)
#   RESTORED_DB    (default pdpp_cck_restored)

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-pdpp-postgres-1}"
PG_HOST_PORT="${PG_HOST_PORT:-55432}"
LIVE_DB="${LIVE_DB:-pdpp_proof}"
SEED_DB="${SEED_DB:-pdpp_cck_seed}"
RESTORED_DB="${RESTORED_DB:-pdpp_cck_restored}"
PG_USER="${PG_USER:-pdpp}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RI_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK_DIR="$RI_DIR/../tmp/canonical-backup-restore-validation"
mkdir -p "$WORK_DIR"

SEED_SQL="$SCRIPT_DIR/fixtures/backup-restore-seed.sql"
BEFORE_COUNTS="$WORK_DIR/before-counts.json"
DUMP_FILE="cck-seed.dump"   # path inside the container's /tmp

log() { printf '\n=== %s ===\n' "$*"; }

require_pg_identifier() {
  if [[ ! "$2" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "$1 must be a simple PostgreSQL identifier, got: $2" >&2
    exit 1
  fi
}

require_pg_identifier LIVE_DB "$LIVE_DB"
require_pg_identifier SEED_DB "$SEED_DB"
require_pg_identifier RESTORED_DB "$RESTORED_DB"
require_pg_identifier PG_USER "$PG_USER"

# Password is read into a variable and never echoed.
PGPW="$(docker inspect "$PG_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^POSTGRES_PASSWORD=//p')"
if [ -z "$PGPW" ]; then echo "could not read POSTGRES_PASSWORD from container env" >&2; exit 1; fi
HOST_URL="postgres://${PG_USER}:${PGPW}@127.0.0.1:${PG_HOST_PORT}/${RESTORED_DB}"

# in-container psql against an arbitrary db
cpsql() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$1"; }

cleanup() {
  log "cleanup: dropping disposable databases"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $SEED_DB WITH (FORCE);" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $RESTORED_DB WITH (FORCE);" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" sh -c "rm -f /tmp/$DUMP_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ----------------------------------------------------------------------
log "1. (re)create disposable seed database $SEED_DB"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $SEED_DB WITH (FORCE);"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $SEED_DB;"

log "2. load REAL reference schema (schema-only) into $SEED_DB"
# Dump live schema and pipe straight into the seed DB, all in-container.
docker exec "$PG_CONTAINER" sh -c \
  "pg_dump -U $PG_USER -d $LIVE_DB --schema-only --no-owner --no-privileges | psql -v ON_ERROR_STOP=1 -U $PG_USER -d $SEED_DB" >/dev/null
echo "schema loaded"

log "3. seed pre-migration rows (URL ids, legacy aliases, wrapped local-device, JSONB)"
cpsql "$SEED_DB" < "$SEED_SQL"
echo "seed applied"

log "3b. patch real first-party manifests into the seed (for the HTTP read step)"
# The SQL fixture seeds THIN manifest bodies (enough for the storage-layer
# migration). The live HTTP read path needs VALID operational manifests to
# resolve streams, so overwrite the seeded connectors.manifest bodies with the
# real first-party manifests BEFORE the dump, so they travel through the
# backup→restore→migrate cycle exactly like a real connector catalog.
SEED_URL="postgres://${PG_USER}:${PGPW}@127.0.0.1:${PG_HOST_PORT}/${SEED_DB}"
( cd "$RI_DIR" && PDPP_DATABASE_URL="$SEED_URL" \
  node scripts/canonical-connector-keys/seed-real-manifests.mjs ) | sed -E 's#//[^:]+:[^@]+@#//<redacted>@#g'

log "4. capture before row counts -> $BEFORE_COUNTS"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SEED_DB" -tAc "
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
    UNION ALL SELECT 'backup_20260601_seed_records', COUNT(*) FROM backup_20260601_seed_records
  ) s;" | tr -d '[:space:]' > "$BEFORE_COUNTS"
cat "$BEFORE_COUNTS"; echo

log "5. pg_dump the seed DB (custom format) — this is the backup"
docker exec "$PG_CONTAINER" sh -c \
  "pg_dump -U $PG_USER -d $SEED_DB -Fc --no-owner --no-privileges -f /tmp/$DUMP_FILE"
docker exec "$PG_CONTAINER" sh -c "ls -l /tmp/$DUMP_FILE"

log "6. restore backup into fresh $RESTORED_DB"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $RESTORED_DB WITH (FORCE);"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $RESTORED_DB;"
docker exec "$PG_CONTAINER" sh -c \
  "pg_restore -U $PG_USER -d $RESTORED_DB --no-owner --no-privileges /tmp/$DUMP_FILE" 2>&1 | tail -3
echo "restore complete"

# ----------------------------------------------------------------------
log "7. inspect (dry-run) the RESTORED db"
( cd "$RI_DIR" && PDPP_STORAGE_BACKEND=postgres PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/cli.mjs inspect ) | sed -E 's#//[^:]+:[^@]+@#//<redacted>@#g'

log "8. write --apply against the RESTORED db"
( cd "$RI_DIR" && PDPP_STORAGE_BACKEND=postgres PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/cli.mjs write --apply ) | sed -E 's#//[^:]+:[^@]+@#//<redacted>@#g'

log "9. verify post-migration invariants (storage layer — SQL)"
( cd "$RI_DIR" && PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/verify-backup-restore.mjs --before "$BEFORE_COUNTS" )

log "9b. verify LIVE HTTP read surfaces against the migrated restore"
# Boots the reference app IN-PROCESS against the restored, migrated DB and
# asserts owner record hydration (canonical key + stale-URL alias), single
# reads, /v1/search, owner dashboard connection hydration, and grant-package
# membership — the path an owner dashboard / assistant / MCP client actually
# traverses, with no human in a browser. Owner subject matches the seed's
# owner_subject_id (owner_sub_1).
( cd "$RI_DIR" && PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/verify-http-surfaces.mjs --owner-subject owner_sub_1 )

log "9c. verify DATA-AGNOSTIC production invariants against the migrated restore"
# The same data-agnostic verifier the owner-run production packet uses
# (docs/operator/canonical-connector-keys-production-restore-packet.md). It
# asserts only structural invariants true for ANY dataset — zero non-canonical
# stragglers in active columns/JSONB and row-count parity — so proving it green
# here proves the exact tool the operator runs against real production data.
( cd "$RI_DIR" && PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/verify-production-invariants.mjs --before "$BEFORE_COUNTS" )

log "10. idempotency: write --apply a SECOND time (plan must be empty)"
( cd "$RI_DIR" && PDPP_STORAGE_BACKEND=postgres PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/cli.mjs write --apply --json ) \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s);
      // migrate() returns { report, plan, applied: applyPlan() }, and
      // applyPlan() returns { applied: { columns, jsonb }, rowCounts }.
      const result=r.applied?.applied ?? r.applied;
      const cols=result?.columns?.length ?? -1;
      const jsonb=(result?.jsonb??[]).reduce((a,j)=>a+(j.rowsUpdated||0),0);
      console.log(`second-run column rewrites: ${cols}, jsonb rewrites: ${jsonb}`);
      if (cols!==0 || jsonb!==0) { console.error("NOT IDEMPOTENT: second run rewrote rows"); process.exit(1); }
      console.log("PASS idempotent: second run rewrote nothing");
    });'

log "11. backup-tier opt-in rewrites backup table only when explicitly requested"
( cd "$RI_DIR" && PDPP_STORAGE_BACKEND=postgres PDPP_DATABASE_URL="$HOST_URL" \
  node scripts/canonical-connector-keys/cli.mjs write --apply --include-backup-tables --json ) \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s);
      const result=r.applied?.applied ?? r.applied;
      const backupColumns=(result?.columns??[]).filter((c)=>c.table==="backup_20260601_seed_records");
      const rewrote=backupColumns.some((c)=>
        c.oldValue==="https://registry.pdpp.org/connectors/gmail" &&
        c.newValue==="gmail" &&
        c.actualRows===1
      );
      console.log(`backup-tier column rewrites: ${backupColumns.length}`);
      if (!rewrote) { console.error("backup-tier opt-in did not rewrite expected row"); process.exit(1); }
      console.log("PASS backup-tier opt-in rewrite");
    });'
backup_after="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$RESTORED_DB" -tAc \
  "SELECT connector_id FROM backup_20260601_seed_records WHERE id=1;")"
if [ "$backup_after" != "gmail" ]; then
  echo "backup-tier opt-in verification failed: expected gmail, got $backup_after" >&2
  exit 1
fi

log "ALL §3.4 STEPS PASSED"
