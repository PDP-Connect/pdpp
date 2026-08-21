// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * H5: crash/restart recovery for manual-upload artifacts. A process that
 * dies mid-upload or mid-validation (crash, OOM, `kill -9`, an unclean
 * deploy restart) leaves the artifact's DB row stuck at `uploaded` or
 * `validating` forever -- nothing else ever revisits it -- and its staged
 * file sits on disk forever too. reconcileAbandonedManualUploadArtifactsAtBoot
 * (wired into server/index.ts's startup sequence, right after the
 * orphaned-run reconciliation) terminalizes such rows once at boot.
 *
 * Most of these tests seed a stuck row directly (simulating the crash --
 * there is no way to actually kill -9 a test process mid-request and keep
 * asserting against it) and call the sweep in-process. The single-process
 * "sweep runs, terminalizes, cleans up" behavior does NOT by itself prove
 * two live server processes can't both claim the same abandoned row -- see
 * the dedicated "genuinely concurrent claim" test below, which spawns a
 * REAL second Node child process with its own independent DB connection
 * against the same SQLite file and races it against this process's own
 * claim call.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createRequestManualUploadArtifactStore } from "../server/request-store-factories.ts";
import { reconcileAbandonedManualUploadArtifactsAtBoot } from "../server/routes/ref-manual-upload-draft-connection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIM_CHILD_ENTRYPOINT = join(__dirname, "manual-upload-claim-sweep-child.ts");
const REPO_ROOT = resolve(__dirname, "..");

/** The epoch of the process running the sweep (this "incarnation"). */
const CURRENT_EPOCH = "epoch-current-0000-0000-0000-000000000000";
/** The epoch of the process that crashed: a DIFFERENT incarnation, so every
 *  in-flight row it left behind is provably orphaned -- that process is gone
 *  and can never finish them. */
const PRIOR_EPOCH = "epoch-prior-1111-1111-1111-111111111111";

function withTmpDb(fn: (ctx: { dbPath: string; dir: string }) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-manual-upload-crash-recovery-"));
    const dbPath = join(dir, "pdpp.sqlite");
    initDb(dbPath);
    try {
      await fn({ dbPath, dir });
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function insertConnectorRow(connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)
       ON CONFLICT(connector_id) DO NOTHING`
    )
    .run(connectorId, JSON.stringify({ connector_id: connectorId, streams: [] }), new Date().toISOString());
}

function stagingDirFor(dir: string, connectorId: string, artifactId: string): string {
  return join(dir, "imports", "_staging", connectorId, artifactId);
}

/**
 * Seeds an in-flight artifact owned by `ownerEpoch`. Passing PRIOR_EPOCH
 * simulates the crash this sweep exists for: the row is exactly as the dead
 * process left it, stamped with THAT process's epoch. Passing CURRENT_EPOCH
 * simulates a live upload owned by the process about to run the sweep.
 * Passing null simulates a legacy row written before the owner_epoch column
 * existed.
 */
function seedInFlightArtifact(args: {
  artifactId: string;
  connectorId: string;
  dir: string;
  ownerEpoch: string | null;
  status: "uploaded" | "validating";
}): string {
  const stagingDir = stagingDirFor(args.dir, args.connectorId, args.artifactId);
  mkdirSync(stagingDir, { recursive: true });
  const stagingPath = join(stagingDir, "export.txt");
  writeFileSync(stagingPath, "abandoned upload contents");

  insertConnectorRow(args.connectorId);
  const store = createRequestManualUploadArtifactStore();
  store.insert({
    artifactId: args.artifactId,
    artifactSha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    connectorId: args.connectorId,
    fileName: "export.txt",
    fileSizeBytes: 26,
    ownerEpoch: args.ownerEpoch,
    ownerSubjectId: "owner_local",
    stagingPath,
    status: args.status,
  });
  return stagingPath;
}

/** Runs the sweep as the CURRENT_EPOCH incarnation. */
function sweepAsCurrentEpoch(): Promise<{ swept: number }> {
  return reconcileAbandonedManualUploadArtifactsAtBoot(
    {
      createRequestManualUploadArtifactStore,
    } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0],
    { ownerEpoch: CURRENT_EPOCH }
  );
}

test(
  "boot-time sweep terminalizes an orphaned 'validating' artifact and cleans up its staging directory",
  withTmpDb(async ({ dir }) => {
    const stagingPath = seedInFlightArtifact({
      artifactId: "mua_stuck_validating",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: PRIOR_EPOCH,
      status: "validating",
    });
    assert.ok(existsSync(stagingPath), "baseline: staged file exists before the sweep");

    const result = await sweepAsCurrentEpoch();

    assert.equal(result.swept, 1, "expected exactly one orphaned artifact to be swept");

    const store = createRequestManualUploadArtifactStore();
    const artifact = await store.get("mua_stuck_validating");
    assert.ok(artifact, "expected the artifact row to still exist");
    assert.equal(artifact?.status, "failed", "stuck artifact must be terminalized to failed, not left validating");
    assert.equal((artifact?.error as { code?: string } | null)?.code, "manual_upload_interrupted");

    assert.ok(!existsSync(stagingPath), "staged file must be cleaned up");
    const stagingArtifactDir = join(dir, "imports", "_staging", "crash-recovery-test", "mua_stuck_validating");
    assert.ok(
      !existsSync(stagingArtifactDir),
      "the whole per-artifact staging directory must be removed, not just the file"
    );
  })
);

test(
  "boot-time sweep terminalizes an orphaned 'uploaded' artifact too (crashed before validation even started)",
  withTmpDb(async ({ dir }) => {
    seedInFlightArtifact({
      artifactId: "mua_stuck_uploaded",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: PRIOR_EPOCH,
      status: "uploaded",
    });

    const result = await sweepAsCurrentEpoch();

    assert.equal(result.swept, 1);
    const store = createRequestManualUploadArtifactStore();
    const artifact = await store.get("mua_stuck_uploaded");
    assert.equal(artifact?.status, "failed");
  })
);

test(
  "boot-time sweep does NOT touch an in-flight artifact owned by the CURRENT epoch (still legitimately owned by a live request)",
  withTmpDb(async ({ dir }) => {
    // Owned by the very process running the sweep -- a real request's
    // setImmediate validation callback could still be running; sweeping this
    // out from under it would fail a legitimate, in-progress upload. This is
    // the case the old 10-minute window could only approximate: a live
    // upload that ran longer than the guess used to become eligible. The
    // epoch excludes it exactly, no matter how long it takes.
    const stagingPath = seedInFlightArtifact({
      artifactId: "mua_still_running",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: CURRENT_EPOCH,
      status: "validating",
    });

    const result = await sweepAsCurrentEpoch();

    assert.equal(result.swept, 0, "an in-flight artifact owned by the current epoch must not be swept");
    const store = createRequestManualUploadArtifactStore();
    const artifact = await store.get("mua_still_running");
    assert.equal(artifact?.status, "validating", "live artifact status must be untouched");
    assert.equal(artifact?.ownerEpoch, CURRENT_EPOCH, "its owner epoch must be untouched too");
    assert.ok(existsSync(stagingPath), "a live upload's staged file must NOT be deleted out from under it");
  })
);

test(
  "boot-time sweep terminalizes a legacy NULL-owner_epoch in-flight artifact (written before the column existed; no live process claims it)",
  withTmpDb(async ({ dir }) => {
    const stagingPath = seedInFlightArtifact({
      artifactId: "mua_legacy_null_epoch",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: null,
      status: "validating",
    });
    const store = createRequestManualUploadArtifactStore();
    assert.equal(
      (await store.get("mua_legacy_null_epoch"))?.ownerEpoch,
      null,
      "baseline: the seeded legacy row really does have a NULL owner_epoch"
    );

    const result = await sweepAsCurrentEpoch();

    assert.equal(result.swept, 1, "a NULL owner_epoch row is unowned, so it must be swept");
    const artifact = await store.get("mua_legacy_null_epoch");
    assert.equal(artifact?.status, "failed");
    assert.equal((artifact?.error as { code?: string } | null)?.code, "manual_upload_interrupted");
    assert.ok(!existsSync(stagingPath), "its staged file must be cleaned up");
  })
);

test(
  "boot-time sweep with NO current epoch treats every in-flight row as unowned (no live owner to protect)",
  withTmpDb(async ({ dir }) => {
    seedInFlightArtifact({
      artifactId: "mua_no_epoch_prior",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: PRIOR_EPOCH,
      status: "validating",
    });
    seedInFlightArtifact({
      artifactId: "mua_no_epoch_null",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: null,
      status: "uploaded",
    });

    const result = await reconcileAbandonedManualUploadArtifactsAtBoot(
      {
        createRequestManualUploadArtifactStore,
      } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0],
      { ownerEpoch: null }
    );

    assert.equal(result.swept, 2, "with no current epoch, both in-flight rows qualify");
    const store = createRequestManualUploadArtifactStore();
    assert.equal((await store.get("mua_no_epoch_prior"))?.status, "failed");
    assert.equal((await store.get("mua_no_epoch_null"))?.status, "failed");
  })
);

test(
  "boot-time sweep does not touch already-terminal artifacts (staged/failed/duplicate), even when orphaned by a prior epoch",
  withTmpDb(async ({ dir }) => {
    const stagingDir = stagingDirFor(dir, "crash-recovery-test", "mua_already_staged");
    mkdirSync(stagingDir, { recursive: true });
    insertConnectorRow("crash-recovery-test");
    const store = createRequestManualUploadArtifactStore();
    store.insert({
      artifactId: "mua_already_staged",
      artifactSha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      connectorId: "crash-recovery-test",
      fileName: "export.txt",
      fileSizeBytes: 26,
      // Orphaned by epoch, but TERMINAL: status alone must keep it out of
      // the sweep. Terminal work is finished work; nobody needs to own it.
      ownerEpoch: PRIOR_EPOCH,
      ownerSubjectId: "owner_local",
      stagingPath: join(stagingDir, "export.txt"),
      status: "staged",
    });

    const result = await sweepAsCurrentEpoch();

    assert.equal(result.swept, 0, "an already-terminal artifact must never be swept, whatever epoch owns it");
    const artifact = await store.get("mua_already_staged");
    assert.equal(artifact?.status, "staged");
  })
);

/**
 * Spawns a real child Node process running manual-upload-claim-sweep-child.ts,
 * which opens its OWN independent DB connection against `dbPath` and calls
 * `claimForSweep` for `artifactId`. Returns the parsed `{ claimed }` result.
 */
function runClaimChild(dbPath: string, artifactId: string, currentEpoch: string, nowIso: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLAIM_CHILD_ENTRYPOINT, dbPath, artifactId, currentEpoch, nowIso],
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
        reject(new Error(`claim child exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { claimed: boolean };
        resolvePromise(parsed.claimed);
      } catch (err) {
        reject(new Error(`claim child produced unparseable output "${stdout}": ${String(err)}`));
      }
    });
  });
}

test(
  "genuinely concurrent claim: two independent processes racing claimForSweep on the SAME artifact -- exactly one wins, never both, never neither",
  withTmpDb(async ({ dbPath, dir }) => {
    // Not an in-process docstring claim: this spawns a REAL second Node
    // process (manual-upload-claim-sweep-child.ts) with its OWN independent
    // better-sqlite3 connection to the SAME on-disk file this test process
    // already has open via withTmpDb's initDb call -- the actual multi-
    // process scenario reconcileAbandonedManualUploadArtifactsAtBoot must be
    // safe under (two live server processes, or one process's boot sweep
    // racing a second concurrent boot sweep).
    seedInFlightArtifact({
      artifactId: "mua_concurrent_race",
      connectorId: "crash-recovery-test",
      dir,
      ownerEpoch: PRIOR_EPOCH,
      status: "validating",
    });

    const nowIso = new Date().toISOString();
    const store = createRequestManualUploadArtifactStore();

    // Fire this process's own claim and the child process's claim as
    // concurrently as this test framework allows -- both target the exact
    // same artifactId, claim as the SAME current epoch, and use (nearly)
    // the same nowIso. Same epoch on both sides is the strictest case: the
    // winner's stamp is indistinguishable from the loser's intended stamp,
    // so only a genuinely atomic compare-and-swap can separate them.
    const [parentClaimed, childClaimed] = await Promise.all([
      Promise.resolve(store.claimForSweep("mua_concurrent_race", CURRENT_EPOCH, nowIso)),
      runClaimChild(dbPath, "mua_concurrent_race", CURRENT_EPOCH, nowIso),
    ]);

    const claimCount = Number(parentClaimed) + Number(childClaimed);
    assert.equal(
      claimCount,
      1,
      `expected EXACTLY ONE of the two concurrent claimers to win, got parent=${String(parentClaimed)} child=${String(childClaimed)}`
    );

    // The artifact must reflect a single, well-defined post-claim state --
    // not a torn write from two overlapping UPDATEs.
    const artifact = await store.get("mua_concurrent_race");
    assert.equal(artifact?.status, "validating", "the claim itself only re-stamps status to 'validating'/updated_at");
  })
);
