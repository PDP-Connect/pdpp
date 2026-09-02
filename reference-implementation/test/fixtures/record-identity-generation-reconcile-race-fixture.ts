/**
 * Genuine second-OS-process participant for the record-identity-generation
 * reconcile concurrency proof
 * (test/polyfill-manifest-reconcile-invalidation-postgres.test.ts).
 *
 * Two independent OS processes each run the FULL
 * `reconcilePolyfillManifests` pass — list checkpoints, invalidate behind
 * instances (fenced per-instance by a real `pg_advisory_lock`), advance the
 * checkpoint — against the SAME connector and SAME manifests directory at
 * (as close as wall-clock allows) the same time. One Node process issuing
 * two concurrent `async` calls would only exercise this module's in-process
 * scheduling, not the real cross-process Postgres advisory lock that
 * `withConnectorInstanceWrite` takes around the per-instance delete phase.
 *
 * Protocol:
 *   1. Connects to Postgres via PDPP_TEST_POSTGRES_URL.
 *   2. Prints `{"ready":true,"pid":...}` to stdout.
 *   3. Immediately runs `reconcilePolyfillManifests` against
 *      RACE_MANIFESTS_DIR / RACE_REFERENCE_FIXTURES_DIR (env-supplied by the
 *      parent, already written to disk before either process spawns).
 *   4. Prints one final JSON line with `{ok, invalidatedConnectors,
 *      invalidatedRecords, updated, errors}` (or `{ok:false, error}` on a
 *      thrown error), then exits 0.
 */

import { closeDb, initDb } from "../../server/db.ts";
import { reconcilePolyfillManifests } from "../../server/polyfill-manifest-reconcile.ts";
import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";

const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
const manifestsDir = process.env.RACE_MANIFESTS_DIR;
const referenceFixturesDir = process.env.RACE_REFERENCE_FIXTURES_DIR;
const childAttachment = process.env.RACE_CHILD_ATTACHMENT;

if (!databaseUrl) {
  throw new Error("record-identity-generation reconcile race fixture requires PDPP_TEST_POSTGRES_URL");
}
if (!(manifestsDir && referenceFixturesDir)) {
  throw new Error(
    "record-identity-generation reconcile race fixture requires RACE_MANIFESTS_DIR and RACE_REFERENCE_FIXTURES_DIR"
  );
}

initDb(":memory:");
await initPostgresStorage(
  { backend: "postgres", databaseUrl },
  childAttachment === undefined ? {} : { testOnlyAlreadyAdmittedChildAttachment: childAttachment }
);
process.stdout.write(`${JSON.stringify({ pid: process.pid, ready: true })}\n`);

try {
  const summary = await reconcilePolyfillManifests({
    enabled: true,
    log: () => {
      /* silenced: this process's stdout is a structured line protocol */
    },
    manifestsDir,
    referenceFixturesDir,
  });
  process.stdout.write(
    `${JSON.stringify({
      errors: summary.errors,
      invalidatedConnectors: summary.invalidatedConnectors,
      invalidatedRecords: summary.invalidatedRecords,
      ok: summary.errors === 0,
      pid: process.pid,
      updated: summary.updated,
    })}\n`
  );
  await closePostgresStorage();
  closeDb();
  process.exit(summary.errors === 0 ? 0 : 1);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      invalidatedConnectors: 0,
      invalidatedRecords: 0,
      ok: false,
      pid: process.pid,
    })}\n`
  );
  try {
    await closePostgresStorage();
    closeDb();
  } catch {
    // Best-effort cleanup after a failed fixture run.
  }
  process.exit(1);
}
