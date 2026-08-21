// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres driver for the manual-upload artifact store and crash-recovery
 * sweep (env-gated on `PDPP_TEST_POSTGRES_URL`).
 *
 * `manual-upload-crash-recovery.test.ts` proves the boot-time sweep
 * (`reconcileAbandonedManualUploadArtifactsAtBoot`), recent-in-flight/
 * terminal counterweights, and the genuinely-concurrent `claimForSweep`
 * CAS against SQLite only. `createPostgresManualUploadArtifactStore` --
 * its `claimForSweep` atomic UPDATE, `listInFlightNotOwnedByEpoch` owner
 * scan, and the JSONB insert/update round-trip -- had ZERO test execution
 * anywhere in the repo before this file: parity with the SQLite oracle was
 * provable only by reading the two query-builder call sites side by side,
 * not behaviorally. This file re-runs the equivalent scenarios against a
 * real Postgres backend, plus a genuine two-OS-process discriminator for
 * `claimForSweep`'s compare-and-swap, so the parity and concurrency claims
 * are proven, not inferred.
 *
 * Every test runs against its own fresh, disposable database created by
 * `withTemporaryPostgresDatabase` and dropped on teardown (`DROP DATABASE
 * ... WITH (FORCE)`) -- never a shared or pre-existing database. The
 * connection URL is additionally gated through `dedicatedPostgresTestUrl`,
 * which structurally REJECTS any URL that is not the dedicated,
 * loopback-only test listener on port 55447: the well-known production
 * compose port (127.0.0.1:55432 -- see docker-compose.yml) and hostname
 * cannot satisfy that grammar, so this file cannot connect to or mutate
 * production even if `PDPP_TEST_POSTGRES_URL` were misconfigured to point
 * at it.
 *
 * Target for local runs:
 *   docker run --rm -d --name pg-pilot -p 127.0.0.1:55447:5432 \
 *     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=pw \
 *     -e POSTGRES_DB=pdpp_test \
 *     pgvector/pgvector:pg16
 *   PDPP_TEST_POSTGRES_URL=postgresql://postgres:pw@127.0.0.1:55447/pdpp_test \
 *     node --experimental-strip-types --test test/manual-upload-artifact-store-postgres.test.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { reconcileAbandonedManualUploadArtifactsAtBoot } from "../server/routes/ref-manual-upload-draft-connection.ts";
import { createPostgresManualUploadArtifactStore } from "../server/stores/manual-upload-artifact-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const RAW_POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_URL = dedicatedPostgresTestUrl(RAW_POSTGRES_URL);

if (RAW_POSTGRES_URL && !POSTGRES_URL) {
  throw new Error(
    "PDPP_TEST_POSTGRES_URL must be a query- and fragment-free dedicated loopback PostgreSQL test URL " +
      "(127.0.0.1:55447) -- refusing to run against an unrecognized or production-shaped connection string"
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIM_CHILD_ENTRYPOINT = join(__dirname, "manual-upload-claim-sweep-postgres-child.ts");
const REPO_ROOT = resolve(__dirname, "..");

/** The epoch of the process running the sweep (this "incarnation"). */
const CURRENT_EPOCH = "epoch-pg-current-0000-0000-000000000000";
/** The epoch of the process that crashed: a DIFFERENT incarnation, so every
 *  in-flight row it left behind is provably orphaned. */
const PRIOR_EPOCH = "epoch-pg-prior-1111-1111-111111111111";

if (POSTGRES_URL) {
  const CONNECTOR_ID = "manual-upload-pg-test-connector";
  let tempCounter = 0;

  function tempDbName(): string {
    tempCounter += 1;
    return `pdpp_test_manual_upload_${process.pid}_${Date.now()}_${tempCounter}`;
  }

  async function seedConnector(): Promise<void> {
    await postgresQuery(
      "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING",
      [CONNECTOR_ID, JSON.stringify({ connector_id: CONNECTOR_ID, streams: [] }), "2026-01-01T00:00:00.000Z"]
    );
  }

  function withPostgresFixture(fn: (ctx: { databaseUrl: string }) => Promise<void>): () => Promise<void> {
    return async () => {
      const databaseUrl = POSTGRES_URL;
      assert.ok(databaseUrl, "Postgres URL configured when this test runs");
      await withTemporaryPostgresDatabase(
        { closeConnections: closePostgresStorage, connectionString: databaseUrl, databaseName: tempDbName() },
        async (tempDatabaseUrl) => {
          await initPostgresStorage({ backend: "postgres", databaseUrl: tempDatabaseUrl });
          try {
            await seedConnector();
            await fn({ databaseUrl: tempDatabaseUrl });
          } finally {
            await closePostgresStorage();
          }
        }
      );
    };
  }

  function insertArtifact(
    overrides: Partial<Parameters<ReturnType<typeof createPostgresManualUploadArtifactStore>["insert"]>[0]> & {
      artifactId: string;
    }
  ) {
    const store = createPostgresManualUploadArtifactStore();
    return store.insert({
      artifactSha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      connectorId: CONNECTOR_ID,
      fileName: "export.txt",
      fileSizeBytes: 26,
      ownerSubjectId: "owner_local",
      stagingPath: `/tmp/pdpp-pg-test/${overrides.artifactId}/export.txt`,
      ...overrides,
    });
  }

  /** Runs the sweep as the CURRENT_EPOCH incarnation against Postgres. */
  function sweepAsCurrentEpoch(): Promise<{ swept: number }> {
    return reconcileAbandonedManualUploadArtifactsAtBoot(
      {
        createRequestManualUploadArtifactStore: createPostgresManualUploadArtifactStore,
      } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0],
      { ownerEpoch: CURRENT_EPOCH }
    );
  }

  test(
    "[postgres] boot-time sweep terminalizes an orphaned 'validating' artifact (parity with the SQLite oracle)",
    withPostgresFixture(async () => {
      await insertArtifact({
        artifactId: "mua_pg_stuck_validating",
        ownerEpoch: PRIOR_EPOCH,
        status: "validating",
      });

      const result = await sweepAsCurrentEpoch();

      assert.equal(result.swept, 1, "expected exactly one orphaned artifact to be swept");

      const store = createPostgresManualUploadArtifactStore();
      const artifact = await store.get("mua_pg_stuck_validating");
      assert.ok(artifact, "expected the artifact row to still exist");
      assert.equal(artifact?.status, "failed", "stuck artifact must be terminalized to failed, not left validating");
      assert.equal((artifact?.error as { code?: string } | null)?.code, "manual_upload_interrupted");
    })
  );

  test(
    "[postgres] boot-time sweep terminalizes an orphaned 'uploaded' artifact too (crashed before validation even started)",
    withPostgresFixture(async () => {
      await insertArtifact({ artifactId: "mua_pg_stuck_uploaded", ownerEpoch: PRIOR_EPOCH, status: "uploaded" });

      const result = await sweepAsCurrentEpoch();

      assert.equal(result.swept, 1);
      const store = createPostgresManualUploadArtifactStore();
      const artifact = await store.get("mua_pg_stuck_uploaded");
      assert.equal(artifact?.status, "failed");
    })
  );

  test(
    "[postgres] boot-time sweep does NOT touch an in-flight artifact owned by the CURRENT epoch (still legitimately owned by a live request)",
    withPostgresFixture(async () => {
      // Owned by the very process running the sweep -- a real request's
      // async validation callback could still be running; sweeping this out
      // from under it would fail a legitimate, in-progress upload, however
      // long that upload legitimately takes.
      await insertArtifact({ artifactId: "mua_pg_still_running", ownerEpoch: CURRENT_EPOCH, status: "validating" });

      const result = await sweepAsCurrentEpoch();

      assert.equal(result.swept, 0, "an in-flight artifact owned by the current epoch must not be swept");
      const store = createPostgresManualUploadArtifactStore();
      const artifact = await store.get("mua_pg_still_running");
      assert.equal(artifact?.status, "validating", "live artifact status must be untouched");
      assert.equal(artifact?.ownerEpoch, CURRENT_EPOCH, "its owner epoch must be untouched too");
    })
  );

  test(
    "[postgres] boot-time sweep terminalizes a legacy NULL-owner_epoch in-flight artifact (written before the column existed; no live process claims it)",
    withPostgresFixture(async () => {
      await insertArtifact({ artifactId: "mua_pg_legacy_null_epoch", ownerEpoch: null, status: "validating" });
      const store = createPostgresManualUploadArtifactStore();
      assert.equal(
        (await store.get("mua_pg_legacy_null_epoch"))?.ownerEpoch,
        null,
        "baseline: the seeded legacy row really does have a NULL owner_epoch"
      );

      const result = await sweepAsCurrentEpoch();

      assert.equal(result.swept, 1, "a NULL owner_epoch row is unowned, so it must be swept");
      const artifact = await store.get("mua_pg_legacy_null_epoch");
      assert.equal(artifact?.status, "failed");
      assert.equal((artifact?.error as { code?: string } | null)?.code, "manual_upload_interrupted");
    })
  );

  test(
    "[postgres] boot-time sweep with NO current epoch treats every in-flight row as unowned (no live owner to protect)",
    withPostgresFixture(async () => {
      await insertArtifact({ artifactId: "mua_pg_no_epoch_prior", ownerEpoch: PRIOR_EPOCH, status: "validating" });
      await insertArtifact({ artifactId: "mua_pg_no_epoch_null", ownerEpoch: null, status: "uploaded" });

      const result = await reconcileAbandonedManualUploadArtifactsAtBoot(
        {
          createRequestManualUploadArtifactStore: createPostgresManualUploadArtifactStore,
        } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0],
        { ownerEpoch: null }
      );

      assert.equal(result.swept, 2, "with no current epoch, both in-flight rows qualify");
      const store = createPostgresManualUploadArtifactStore();
      assert.equal((await store.get("mua_pg_no_epoch_prior"))?.status, "failed");
      assert.equal((await store.get("mua_pg_no_epoch_null"))?.status, "failed");
    })
  );

  test(
    "[postgres] boot-time sweep does not touch already-terminal artifacts (staged/failed/duplicate), even when orphaned by a prior epoch",
    withPostgresFixture(async () => {
      for (const status of ["staged", "failed", "duplicate"] as const) {
        const artifactId = `mua_pg_terminal_${status}`;
        // Orphaned by epoch, but TERMINAL: status alone must keep each out
        // of the sweep. Terminal work is finished work; nobody needs to own
        // it.
        // biome-ignore lint/performance/noAwaitInLoops: bounded 3-item fixture setup; sequential keeps each artifact's insert atomic relative to the next.
        await insertArtifact({ artifactId, ownerEpoch: PRIOR_EPOCH, status });
      }

      const result = await sweepAsCurrentEpoch();

      assert.equal(result.swept, 0, "no already-terminal artifact must ever be swept, whatever epoch owns it");
      const store = createPostgresManualUploadArtifactStore();
      for (const status of ["staged", "failed", "duplicate"] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded 3-item assertion loop.
        const artifact = await store.get(`mua_pg_terminal_${status}`);
        assert.equal(artifact?.status, status, `${status} artifact status must be untouched by the sweep`);
      }
    })
  );

  test(
    "[postgres] listInFlightNotOwnedByEpoch returns only in-flight rows not owned by the current epoch, ordered oldest-first, excluding terminal statuses whatever epoch owns them",
    withPostgresFixture(async () => {
      // Distinct updated_at stamps only fix the ORDER of the result; they no
      // longer decide membership. Eligibility is entirely the owner epoch.
      const veryOld = "2026-01-01T00:00:00.000Z";
      const old = "2026-01-02T00:00:00.000Z";

      await insertArtifact({
        artifactId: "mua_pg_scan_old_uploaded",
        ownerEpoch: PRIOR_EPOCH,
        status: "uploaded",
        updatedAt: old,
      });
      await insertArtifact({
        artifactId: "mua_pg_scan_very_old_validating",
        ownerEpoch: PRIOR_EPOCH,
        status: "validating",
        updatedAt: veryOld,
      });
      // Owned by the CURRENT epoch: live, so excluded no matter how old its
      // updated_at is -- the exact case a wall-clock cutoff got wrong.
      await insertArtifact({
        artifactId: "mua_pg_scan_live_validating",
        ownerEpoch: CURRENT_EPOCH,
        status: "validating",
        updatedAt: veryOld,
      });
      // Legacy NULL owner: unowned, therefore eligible.
      await insertArtifact({
        artifactId: "mua_pg_scan_null_epoch_uploaded",
        ownerEpoch: null,
        status: "uploaded",
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
      await insertArtifact({
        artifactId: "mua_pg_scan_old_staged",
        ownerEpoch: PRIOR_EPOCH,
        status: "staged",
        updatedAt: veryOld,
      });

      const store = createPostgresManualUploadArtifactStore();
      const stuck = await store.listInFlightNotOwnedByEpoch(CURRENT_EPOCH);
      assert.deepEqual(
        stuck.map((row) => row.artifactId),
        ["mua_pg_scan_very_old_validating", "mua_pg_scan_old_uploaded", "mua_pg_scan_null_epoch_uploaded"],
        "only the unowned in-flight rows are returned, ordered oldest updated_at first, excluding both the terminal staged row and the live current-epoch row despite their age"
      );
    })
  );

  test(
    "[postgres] claimForSweep is a compare-and-swap: it wins exactly once for an orphaned in-flight row and never claims a live current-epoch or terminal row",
    withPostgresFixture(async () => {
      const nowIso = new Date().toISOString();

      await insertArtifact({ artifactId: "mua_pg_claim_orphan", ownerEpoch: PRIOR_EPOCH, status: "validating" });
      await insertArtifact({ artifactId: "mua_pg_claim_live", ownerEpoch: CURRENT_EPOCH, status: "validating" });
      await insertArtifact({ artifactId: "mua_pg_claim_terminal", ownerEpoch: PRIOR_EPOCH, status: "failed" });

      const store = createPostgresManualUploadArtifactStore();

      assert.equal(
        await store.claimForSweep("mua_pg_claim_orphan", CURRENT_EPOCH, nowIso),
        true,
        "a genuinely orphaned in-flight row must be claimable"
      );
      assert.equal(
        await store.claimForSweep("mua_pg_claim_orphan", CURRENT_EPOCH, nowIso),
        false,
        "a second claim attempt on the SAME already-claimed row must lose: the winning claim stamped it with the current epoch, so it is now owned"
      );
      assert.equal(
        await store.claimForSweep("mua_pg_claim_live", CURRENT_EPOCH, nowIso),
        false,
        "a row owned by the current epoch must never be claimable, even if its status is in-flight"
      );
      assert.equal(
        await store.claimForSweep("mua_pg_claim_terminal", CURRENT_EPOCH, nowIso),
        false,
        "a terminal-status row must never be claimable, whatever epoch owns it"
      );

      const claimed = await store.get("mua_pg_claim_orphan");
      assert.equal(claimed?.status, "validating", "the claim itself only re-stamps status to 'validating'/updated_at");
      assert.equal(claimed?.ownerEpoch, CURRENT_EPOCH, "the winning claim takes ownership by stamping its own epoch");
      const untouchedLive = await store.get("mua_pg_claim_live");
      assert.equal(untouchedLive?.status, "validating");
      const untouchedTerminal = await store.get("mua_pg_claim_terminal");
      assert.equal(untouchedTerminal?.status, "failed");
      assert.equal(untouchedTerminal?.ownerEpoch, PRIOR_EPOCH, "a losing claim must not re-stamp ownership");
    })
  );

  test(
    "[postgres] insert/get JSONB round-trip: validation and error payloads survive exactly through the ::jsonb cast",
    withPostgresFixture(async () => {
      const store = createPostgresManualUploadArtifactStore();
      await store.insert({
        artifactId: "mua_pg_jsonb_roundtrip",
        connectorId: CONNECTOR_ID,
        error: { code: "manual_upload_interrupted", detail: { nested: true, values: [1, 2, 3] } },
        fileName: "export.txt",
        ownerSubjectId: "owner_local",
        stagingPath: "/tmp/pdpp-pg-test/mua_pg_jsonb_roundtrip/export.txt",
        validation: { streamCounts: { items: 2 }, warnings: ["a", "b"] },
      });

      const artifact = await store.get("mua_pg_jsonb_roundtrip");
      assert.deepEqual(artifact?.validation, { streamCounts: { items: 2 }, warnings: ["a", "b"] });
      assert.deepEqual(artifact?.error, {
        code: "manual_upload_interrupted",
        detail: { nested: true, values: [1, 2, 3] },
      });
    })
  );

  test(
    "[postgres] update patch preserves untouched JSONB columns and applies COALESCE semantics identically to the SQLite oracle",
    withPostgresFixture(async () => {
      const store = createPostgresManualUploadArtifactStore();
      await store.insert({
        artifactId: "mua_pg_patch_coalesce",
        connectorId: CONNECTOR_ID,
        fileName: "export.txt",
        ownerSubjectId: "owner_local",
        stagingPath: "/tmp/pdpp-pg-test/mua_pg_patch_coalesce/export.txt",
        validation: { warnings: [] },
      });

      await store.update("mua_pg_patch_coalesce", { status: "staged" });
      const afterStatusPatch = await store.get("mua_pg_patch_coalesce");
      assert.equal(afterStatusPatch?.status, "staged");
      assert.deepEqual(
        afterStatusPatch?.validation,
        { warnings: [] },
        "a patch that does not mention validation must leave the existing JSONB value untouched"
      );

      await store.update("mua_pg_patch_coalesce", { validation: { warnings: ["late"] } });
      const afterValidationPatch = await store.get("mua_pg_patch_coalesce");
      assert.equal(afterValidationPatch?.status, "staged", "a validation-only patch must not regress status");
      assert.deepEqual(afterValidationPatch?.validation, { warnings: ["late"] });
    })
  );

  // ─── Genuine cross-process concurrency proof ────────────────────────────
  //
  // Two independent OS processes (not two in-process async calls -- an
  // in-process race proves nothing about the real atomic UPDATE ... WHERE
  // guard; both calls would run against the SAME pg Pool and the same
  // event loop, so ordinary async interleaving could trivially make an
  // unguarded implementation look safe) race claimForSweep on the SAME
  // artifact row. Exactly one must win.
  function spawnClaimChild(databaseUrl: string, artifactId: string, currentEpoch: string, nowIso: string) {
    return new Promise<boolean>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", CLAIM_CHILD_ENTRYPOINT, databaseUrl, artifactId, currentEpoch, nowIso],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`postgres claim child exited ${String(code)}: ${stderr}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { claimed: boolean };
          resolvePromise(parsed.claimed);
        } catch (err) {
          reject(new Error(`postgres claim child produced unparseable output "${stdout}": ${String(err)}`));
        }
      });
    });
  }

  test(
    "[postgres] genuinely concurrent claim: two independent OS processes racing claimForSweep on the SAME artifact against the real Postgres backend -- exactly one wins, never both, never neither",
    withPostgresFixture(async ({ databaseUrl }) => {
      await insertArtifact({ artifactId: "mua_pg_concurrent_race", ownerEpoch: PRIOR_EPOCH, status: "validating" });

      const nowIso = new Date().toISOString();
      const store = createPostgresManualUploadArtifactStore();

      // Fire this process's own claim and the child process's claim as
      // concurrently as this test framework allows -- both target the exact
      // same artifactId, claim as the SAME current epoch, and use (nearly)
      // the same nowIso, against the SAME disposable database via its own
      // independent pg Pool in the child process. Same epoch on both sides
      // is the strictest case: the winner's stamp is indistinguishable from
      // the loser's intended stamp, so only a genuinely atomic
      // compare-and-swap can separate them.
      const [parentClaimed, childClaimed] = await Promise.all([
        store.claimForSweep("mua_pg_concurrent_race", CURRENT_EPOCH, nowIso),
        spawnClaimChild(databaseUrl, "mua_pg_concurrent_race", CURRENT_EPOCH, nowIso),
      ]);

      const claimCount = Number(parentClaimed) + Number(childClaimed);
      assert.equal(
        claimCount,
        1,
        `expected EXACTLY ONE of the two concurrent claimers to win, got parent=${String(parentClaimed)} child=${String(childClaimed)}`
      );

      const artifact = await store.get("mua_pg_concurrent_race");
      assert.equal(artifact?.status, "validating", "the claim itself only re-stamps status to 'validating'/updated_at");
    })
  );
} else {
  test("manual-upload artifact store Postgres oracle (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  }, () => {});
}
