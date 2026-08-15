// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone child-process entrypoint for
 * manual-upload-crash-recovery.test.ts's genuinely-concurrent claim test.
 * Opens its OWN independent DB connection (via initDb, a fresh module-level
 * `db` singleton in THIS process, entirely separate from the parent test
 * process's connection) against the SAME on-disk SQLite file the parent
 * already has open, then races the parent to claim one artifact for sweep
 * via `claimForSweep` -- the real primitive `reconcileAbandonedManualUploadArtifactsAtBoot`
 * uses to decide sweep ownership.
 *
 * Args (argv[2..]): dbPath artifactId cutoffIso nowIso
 * Output: a single JSON line on stdout: {"claimed": boolean}
 */

import { initDb } from "../server/db.ts";
import { createRequestManualUploadArtifactStore } from "../server/request-store-factories.ts";

async function main(): Promise<void> {
  const [dbPath, artifactId, cutoffIso, nowIso] = process.argv.slice(2);
  if (!(dbPath && artifactId && cutoffIso && nowIso)) {
    throw new Error("usage: manual-upload-claim-sweep-child.ts <dbPath> <artifactId> <cutoffIso> <nowIso>");
  }
  initDb(dbPath);
  const store = createRequestManualUploadArtifactStore();
  const claimed = await store.claimForSweep(artifactId, cutoffIso, nowIso);
  process.stdout.write(`${JSON.stringify({ claimed })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
