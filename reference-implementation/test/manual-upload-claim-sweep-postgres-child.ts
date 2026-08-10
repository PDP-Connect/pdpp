// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone child-process entrypoint for
 * manual-upload-artifact-store-postgres.test.ts's genuinely-concurrent claim
 * test. Opens its OWN independent `pg` Pool (via initPostgresStorage, a
 * fresh module-level pool in THIS process, entirely separate from the
 * parent test process's pool) against the SAME disposable Postgres
 * database the parent already has open, then races the parent to claim one
 * artifact for sweep via `claimForSweep` -- the real primitive
 * `reconcileAbandonedManualUploadArtifactsAtBoot` uses to decide sweep
 * ownership. Mirrors manual-upload-claim-sweep-child.ts's SQLite shape.
 *
 * Args (argv[2..]): databaseUrl artifactId cutoffIso nowIso
 * Output: a single JSON line on stdout: {"claimed": boolean}
 */

import { initPostgresStorage } from "../server/postgres-storage.ts";
import { createPostgresManualUploadArtifactStore } from "../server/stores/manual-upload-artifact-store.ts";

async function main(): Promise<void> {
  const [databaseUrl, artifactId, cutoffIso, nowIso] = process.argv.slice(2);
  if (!(databaseUrl && artifactId && cutoffIso && nowIso)) {
    throw new Error(
      "usage: manual-upload-claim-sweep-postgres-child.ts <databaseUrl> <artifactId> <cutoffIso> <nowIso>"
    );
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const store = createPostgresManualUploadArtifactStore();
  const claimed = await store.claimForSweep(artifactId, cutoffIso, nowIso);
  process.stdout.write(`${JSON.stringify({ claimed })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
