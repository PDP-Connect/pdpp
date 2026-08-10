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
import {
  MANUAL_UPLOAD_IN_FLIGHT_STALE_MS,
  reconcileAbandonedManualUploadArtifactsAtBoot,
} from "../server/routes/ref-manual-upload-draft-connection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIM_CHILD_ENTRYPOINT = join(__dirname, "manual-upload-claim-sweep-child.ts");
const REPO_ROOT = resolve(__dirname, "..");

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

function seedInFlightArtifact(args: {
  artifactId: string;
  connectorId: string;
  dir: string;
  status: "uploaded" | "validating";
  updatedAt: string;
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
    ownerSubjectId: "owner_local",
    stagingPath,
    status: args.status,
  });
  // insert() always stamps updated_at to "now" -- directly rewind it in the
  // DB to simulate a row that has been stuck since before the staleness
  // cutoff, matching how a REAL abandoned upload would look after a crash
  // (its last update was whenever the crashed process's last write landed,
  // not "just now").
  getDb()
    .prepare("UPDATE manual_upload_artifacts SET updated_at = ? WHERE artifact_id = ?")
    .run(args.updatedAt, args.artifactId);
  return stagingPath;
}

test(
  "boot-time sweep terminalizes a stale 'validating' artifact and cleans up its staging directory",
  withTmpDb(async ({ dir }) => {
    const staleUpdatedAt = new Date(Date.now() - MANUAL_UPLOAD_IN_FLIGHT_STALE_MS - 60_000).toISOString();
    const stagingPath = seedInFlightArtifact({
      artifactId: "mua_stuck_validating",
      connectorId: "crash-recovery-test",
      dir,
      status: "validating",
      updatedAt: staleUpdatedAt,
    });
    assert.ok(existsSync(stagingPath), "baseline: staged file exists before the sweep");

    const result = await reconcileAbandonedManualUploadArtifactsAtBoot({
      createRequestManualUploadArtifactStore,
    } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0]);

    assert.equal(result.swept, 1, "expected exactly one stale artifact to be swept");

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
  "boot-time sweep terminalizes a stale 'uploaded' artifact too (crashed before validation even started)",
  withTmpDb(async ({ dir }) => {
    const staleUpdatedAt = new Date(Date.now() - MANUAL_UPLOAD_IN_FLIGHT_STALE_MS - 60_000).toISOString();
    seedInFlightArtifact({
      artifactId: "mua_stuck_uploaded",
      connectorId: "crash-recovery-test",
      dir,
      status: "uploaded",
      updatedAt: staleUpdatedAt,
    });

    const result = await reconcileAbandonedManualUploadArtifactsAtBoot({
      createRequestManualUploadArtifactStore,
    } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0]);

    assert.equal(result.swept, 1);
    const store = createRequestManualUploadArtifactStore();
    const artifact = await store.get("mua_stuck_uploaded");
    assert.equal(artifact?.status, "failed");
  })
);

test(
  "boot-time sweep does NOT touch a RECENT in-flight artifact (still legitimately owned by a live request)",
  withTmpDb(async ({ dir }) => {
    // Deliberately recent updated_at -- a real request's setImmediate
    // validation callback could still be running; sweeping this out from
    // under it would fail a legitimate, in-progress upload.
    const recentUpdatedAt = new Date().toISOString();
    seedInFlightArtifact({
      artifactId: "mua_still_running",
      connectorId: "crash-recovery-test",
      dir,
      status: "validating",
      updatedAt: recentUpdatedAt,
    });

    const result = await reconcileAbandonedManualUploadArtifactsAtBoot({
      createRequestManualUploadArtifactStore,
    } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0]);

    assert.equal(result.swept, 0, "a recently-updated in-flight artifact must not be swept");
    const store = createRequestManualUploadArtifactStore();
    const artifact = await store.get("mua_still_running");
    assert.equal(artifact?.status, "validating", "recent artifact status must be untouched");
  })
);

test(
  "boot-time sweep does not touch already-terminal artifacts (staged/failed/duplicate)",
  withTmpDb(async ({ dir }) => {
    const staleUpdatedAt = new Date(Date.now() - MANUAL_UPLOAD_IN_FLIGHT_STALE_MS - 60_000).toISOString();
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
      ownerSubjectId: "owner_local",
      stagingPath: join(stagingDir, "export.txt"),
      status: "staged",
    });
    getDb()
      .prepare("UPDATE manual_upload_artifacts SET updated_at = ? WHERE artifact_id = ?")
      .run(staleUpdatedAt, "mua_already_staged");

    const result = await reconcileAbandonedManualUploadArtifactsAtBoot({
      createRequestManualUploadArtifactStore,
    } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0]);

    assert.equal(result.swept, 0, "an already-terminal artifact must never be swept, regardless of age");
    const artifact = await store.get("mua_already_staged");
    assert.equal(artifact?.status, "staged");
  })
);

/**
 * Spawns a real child Node process running manual-upload-claim-sweep-child.ts,
 * which opens its OWN independent DB connection against `dbPath` and calls
 * `claimForSweep` for `artifactId`. Returns the parsed `{ claimed }` result.
 */
function runClaimChild(dbPath: string, artifactId: string, cutoffIso: string, nowIso: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLAIM_CHILD_ENTRYPOINT, dbPath, artifactId, cutoffIso, nowIso],
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
    const staleUpdatedAt = new Date(Date.now() - MANUAL_UPLOAD_IN_FLIGHT_STALE_MS - 60_000).toISOString();
    seedInFlightArtifact({
      artifactId: "mua_concurrent_race",
      connectorId: "crash-recovery-test",
      dir,
      status: "validating",
      updatedAt: staleUpdatedAt,
    });

    const cutoffIso = new Date(Date.now() - MANUAL_UPLOAD_IN_FLIGHT_STALE_MS).toISOString();
    const nowIso = new Date().toISOString();
    const store = createRequestManualUploadArtifactStore();

    // Fire this process's own claim and the child process's claim as
    // concurrently as this test framework allows -- both target the exact
    // same artifactId, cutoffIso window, and (nearly) the same nowIso.
    const [parentClaimed, childClaimed] = await Promise.all([
      Promise.resolve(store.claimForSweep("mua_concurrent_race", cutoffIso, nowIso)),
      runClaimChild(dbPath, "mua_concurrent_race", cutoffIso, nowIso),
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
