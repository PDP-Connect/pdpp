// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Smallest executable SQLite restore drill for the backup inventory contract.
 *
 * This is intentionally a stopped-snapshot oracle, not a backup product: it
 * closes SQLite, copies a /var/lib/pdpp-shaped durable root with Node APIs,
 * restores it to the SAME absolute root, then proves the restored DB,
 * credential key file, artifact/profile files, records, blobs, search rebuild,
 * and boot reconciliation still agree on one recovery point.
 *
 * Current product contract: persisted artifact/profile metadata stores absolute
 * paths, and this change does not add a restore rebase tool. A portable host
 * restore is supported only when the durable root is mounted at the same
 * absolute path. The negative relocation oracle below fails closed if stale
 * source-root metadata would otherwise look restored.
 *
 * Not proven here: Postgres, platform snapshot primitives, relocated absolute
 * path rebasing, live browser profile usability, or a full HTTP owner journey.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../lib/controller-boot.ts";
import { clearCurrentBootEpoch } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { lexicalIndexBackfillForManifest } from "../server/search.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CREDENTIAL_ENCRYPTION_KEY_FILE_ENV,
} from "../server/stores/credential-encryption.ts";

const OWNER_SUBJECT_ID = "owner_local";
const CONNECTOR_ID = "restore-drill";
const CONNECTOR_INSTANCE_ID = "cin_restore_drill_00000001";
const STREAM = "items";
const RECORD_KEY = "record-1";
const NOW = "2026-08-11T12:00:00.000Z";
const SECRET = "restore-drill-static-secret";
const ARTIFACT_BYTES = "restore artifact recovery point\n";
const PROFILE_BYTES = "restore profile marker\n";

interface CountRow {
  count: number;
}

interface BlobRow {
  data: Buffer;
  sha256: string;
  size_bytes: number;
}

interface RecordRow {
  record_json: string;
}

interface RestoredPathRows {
  artifactFinalPath: string;
  artifactStagingPath: string;
  profileDir: string;
}

interface RunHistoryRow {
  records_emitted: number;
  status: string;
}

interface SpineTerminalRow {
  data_json: string;
  status: string;
}

function copyDirectory(from: string, to: string): void {
  rmSync(to, { force: true, recursive: true });
  cpSync(from, to, { recursive: true });
}

function readRestoredPathRows(): RestoredPathRows {
  const artifact = getDb()
    .prepare(
      `SELECT staging_path, final_path
         FROM manual_upload_artifacts
        WHERE artifact_id = 'artifact_restore_drill'`
    )
    .get() as { final_path: string | null; staging_path: string } | undefined;
  const surface = getDb()
    .prepare("SELECT profile_dir FROM browser_surfaces WHERE surface_id = 'surface_restore_drill'")
    .get() as { profile_dir: string | null } | undefined;
  assert.ok(artifact, "restored DB must contain the manual-upload artifact metadata row");
  assert.ok(artifact.final_path, "restored artifact row must contain a final_path");
  assert.ok(surface, "restored DB must contain the browser surface metadata row");
  assert.ok(surface.profile_dir, "restored browser surface row must contain a profile_dir");
  return {
    artifactFinalPath: artifact.final_path,
    artifactStagingPath: artifact.staging_path,
    profileDir: surface.profile_dir,
  };
}

function seedConnectorInstance(): void {
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify({
      connector_id: CONNECTOR_ID,
      display_name: "Restore Drill",
      streams: [{ name: STREAM, query: { search: { lexical_fields: ["title"] } } }],
    }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(CONNECTOR_INSTANCE_ID, OWNER_SUBJECT_ID, CONNECTOR_ID, "Restore Drill", CONNECTOR_INSTANCE_ID, NOW, NOW);
}

function seedRecordAndBlob(): { blobId: string; blobSha256: string } {
  const db = getDb();
  const record = {
    attachment: { blob_ref: { blob_id: "" } },
    title: "restore drill searchable phrase",
  };
  const blobBytes = Buffer.from("restored blob bytes\n", "utf8");
  const blobSha256 = createHash("sha256").update(blobBytes).digest("hex");
  const blobId = `blob_sha256_${blobSha256}`;
  record.attachment.blob_ref.blob_id = blobId;

  db.prepare(
    `INSERT INTO records(
       connector_id, connector_instance_id, stream, record_key, record_json,
       emitted_at, semantic_time, version, deleted
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY, JSON.stringify(record), NOW, NOW);
  db.prepare(
    `INSERT INTO record_changes(
       connector_id, connector_instance_id, stream, record_key, version,
       record_json, emitted_at, deleted
     ) VALUES (?, ?, ?, ?, 1, ?, ?, 0)`
  ).run(CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY, JSON.stringify(record), NOW);
  db.prepare(
    `INSERT INTO blobs(
       blob_id, connector_id, connector_instance_id, stream, record_key,
       mime_type, size_bytes, sha256, data
     ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`
  ).run(blobId, CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY, blobBytes.length, blobSha256, blobBytes);
  db.prepare(
    `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
     VALUES (?, ?, ?, ?, ?, '/attachment/blob_ref')`
  ).run(blobId, CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY);

  return { blobId, blobSha256 };
}

function seedFilesystemState(root: string): { artifactPath: string; profileDir: string; profileMarkerPath: string } {
  const artifactPath = join(root, "connector-artifacts", CONNECTOR_INSTANCE_ID, "archive.txt");
  const profileDir = join(root, "browser-profiles", CONNECTOR_INSTANCE_ID, "Default");
  const profileMarkerPath = join(profileDir, "restore-marker.txt");
  mkdirSync(join(root, "connector-artifacts", CONNECTOR_INSTANCE_ID), { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(artifactPath, ARTIFACT_BYTES);
  writeFileSync(profileMarkerPath, PROFILE_BYTES);

  const db = getDb();
  db.prepare(
    `INSERT INTO manual_upload_artifacts(
       artifact_id, owner_subject_id, connector_id, connector_instance_id,
       file_name, staging_path, final_path, file_size_bytes, artifact_sha256,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`
  ).run(
    "artifact_restore_drill",
    OWNER_SUBJECT_ID,
    CONNECTOR_ID,
    CONNECTOR_INSTANCE_ID,
    "archive.txt",
    artifactPath,
    artifactPath,
    Buffer.byteLength(ARTIFACT_BYTES),
    createHash("sha256").update(ARTIFACT_BYTES).digest("hex"),
    NOW,
    NOW
  );
  db.prepare(
    `INSERT INTO browser_surfaces(
       surface_id, backend, profile_key, connector_id, surface_subject_id,
       cdp_url, stream_base_url, health, profile_dir, created_at, last_used_at
     ) VALUES (?, 'neko', ?, ?, ?, 'http://127.0.0.1:9222', 'http://127.0.0.1:8080', 'ready', ?, ?, ?)`
  ).run("surface_restore_drill", CONNECTOR_INSTANCE_ID, CONNECTOR_ID, OWNER_SUBJECT_ID, profileDir, NOW, NOW);
  return { artifactPath, profileDir, profileMarkerPath };
}

function seedOrphanedRun(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO spine_events(
       event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id,
       source_kind, source_id, connector_instance_id, data_json, version
     ) VALUES (
       'evt_restore_orphan', 'run.started', ?, ?, 'default', 'trace_restore',
       'runtime', ?, 'run', 'run_restore_orphan', 'started', 'run_restore_orphan',
       'connector', ?, ?, ?, 'v1'
     )`
  ).run(
    NOW,
    NOW,
    CONNECTOR_ID,
    CONNECTOR_ID,
    CONNECTOR_INSTANCE_ID,
    JSON.stringify({ connection_id: CONNECTOR_INSTANCE_ID, connector_instance_id: CONNECTOR_INSTANCE_ID })
  );
  db.prepare(
    `INSERT INTO run_history(
       run_id, connector_instance_id, connector_id, trigger_kind, source_json,
       status, known_gaps_json, started_at, records_emitted, attempt
     ) VALUES (
       'run_restore_orphan', ?, ?, 'manual', '{}', 'running', '[]', ?, 1, 1
     )`
  ).run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, NOW);
}

async function proveRestoredSearchRebuild(): Promise<void> {
  getDb()
    .prepare("DELETE FROM lexical_search_index WHERE connector_instance_id = ? AND stream = ?")
    .run(CONNECTOR_INSTANCE_ID, STREAM);
  getDb()
    .prepare("DELETE FROM lexical_search_meta WHERE connector_instance_id = ? AND stream = ?")
    .run(CONNECTOR_INSTANCE_ID, STREAM);

  await lexicalIndexBackfillForManifest({
    log: () => undefined,
    manifest: {
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      streams: [{ name: STREAM, query: { search: { lexical_fields: ["title"] } } }],
    },
  });

  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM lexical_search_index
        WHERE connector_instance_id = ?
          AND stream = ?
          AND record_key = ?
          AND text LIKE '%searchable phrase%'`
    )
    .get(CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY) as CountRow;
  assert.equal(row.count, 1, "restored records must rebuild the derived lexical search index");
}

async function seedSourceRoot(durableRoot: string): Promise<{ blobId: string; blobSha256: string }> {
  const keyFile = join(durableRoot, "credential-encryption-key");
  writeFileSync(keyFile, "restore-drill-key-material\n");
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV] = keyFile;

  initDb(join(durableRoot, "pdpp.sqlite"));
  seedConnectorInstance();
  const blob = seedRecordAndBlob();
  await createSqliteConnectorInstanceCredentialStore().capture({
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    credentialKind: "personal_access_token",
    now: NOW,
    ownerSubjectId: OWNER_SUBJECT_ID,
    secret: SECRET,
  });
  seedFilesystemState(durableRoot);
  seedOrphanedRun();
  closeDb();
  return blob;
}

test("SQLite stopped snapshot restore to the same durable root preserves DB, keys, files, rebuildable search, and orphan reconciliation", async () => {
  const durableRoot = await mkdtemp(join(tmpdir(), "pdpp-sqlite-restore-source-"));
  const snapshotRoot = await mkdtemp(join(tmpdir(), "pdpp-sqlite-restore-snapshot-"));
  const previousEnv = {
    credentialKey: process.env[CREDENTIAL_ENCRYPTION_KEY_ENV],
    credentialKeyFile: process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV],
  };

  try {
    const { blobId, blobSha256 } = await seedSourceRoot(durableRoot);

    copyDirectory(durableRoot, snapshotRoot);
    rmSync(durableRoot, { force: true, recursive: true });
    copyDirectory(snapshotRoot, durableRoot);

    process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV] = join(durableRoot, "credential-encryption-key");
    initDb(join(durableRoot, "pdpp.sqlite"));

    const recovered = await createSqliteConnectorInstanceCredentialStore().recoverSecret({
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    assert.deepEqual(recovered, { credentialKind: "personal_access_token", secret: SECRET });

    const record = getDb()
      .prepare("SELECT record_json FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
      .get(CONNECTOR_INSTANCE_ID, STREAM, RECORD_KEY) as RecordRow | undefined;
    assert.ok(record, "restored DB must contain the recovery-point record");
    assert.equal(JSON.parse(record.record_json).title, "restore drill searchable phrase");

    const blob = getDb().prepare("SELECT sha256, size_bytes, data FROM blobs WHERE blob_id = ?").get(blobId) as
      | BlobRow
      | undefined;
    assert.ok(blob, "restored DB must contain the recovery-point blob");
    assert.equal(blob.sha256, blobSha256);
    assert.equal(blob.size_bytes, Buffer.byteLength("restored blob bytes\n"));
    assert.equal(Buffer.from(blob.data).toString("utf8"), "restored blob bytes\n");

    const restoredPaths = readRestoredPathRows();
    assert.equal(readFileSync(restoredPaths.artifactFinalPath, "utf8"), ARTIFACT_BYTES);
    assert.equal(readFileSync(restoredPaths.artifactStagingPath, "utf8"), ARTIFACT_BYTES);
    assert.equal(readFileSync(join(restoredPaths.profileDir, "restore-marker.txt"), "utf8"), PROFILE_BYTES);

    await proveRestoredSearchRebuild();

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "restore-drill-boot",
      controllerId: "restore-drill-controller",
    });
    await reconcileOrphanedRunsAtBoot(epoch);
    const run = getDb()
      .prepare("SELECT status, records_emitted FROM run_history WHERE run_id = 'run_restore_orphan'")
      .get() as RunHistoryRow | undefined;
    assert.ok(run, "restored run_history row should still exist");
    assert.equal(run.records_emitted, 1, "committed records from an orphaned run must survive reconciliation");
    const abandoned = getDb()
      .prepare("SELECT status, data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.abandoned'")
      .get("run_restore_orphan") as SpineTerminalRow | undefined;
    assert.ok(abandoned, "restored orphaned run should receive a durable terminal Spine event");
    assert.equal(abandoned.status, "abandoned");
    assert.equal(JSON.parse(abandoned.data_json).reason, "controller_terminated_before_run_finished");
  } finally {
    closeDb();
    clearCurrentBootEpoch();
    if (previousEnv.credentialKey === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = previousEnv.credentialKey;
    }
    if (previousEnv.credentialKeyFile === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV] = previousEnv.credentialKeyFile;
    }
    rmSync(durableRoot, { force: true, recursive: true });
    rmSync(snapshotRoot, { force: true, recursive: true });
  }
});

test("SQLite restore drill fails closed when absolute artifact/profile metadata is relocated without a rebase", async () => {
  const durableRoot = await mkdtemp(join(tmpdir(), "pdpp-sqlite-restore-source-"));
  const snapshotRoot = await mkdtemp(join(tmpdir(), "pdpp-sqlite-restore-snapshot-"));
  const relocatedRoot = await mkdtemp(join(tmpdir(), "pdpp-sqlite-restore-relocated-"));
  const previousEnv = {
    credentialKey: process.env[CREDENTIAL_ENCRYPTION_KEY_ENV],
    credentialKeyFile: process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV],
  };

  try {
    await seedSourceRoot(durableRoot);
    copyDirectory(durableRoot, snapshotRoot);
    rmSync(durableRoot, { force: true, recursive: true });
    copyDirectory(snapshotRoot, relocatedRoot);

    process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV] = join(relocatedRoot, "credential-encryption-key");
    initDb(join(relocatedRoot, "pdpp.sqlite"));

    const restoredPaths = readRestoredPathRows();
    assert.equal(
      restoredPaths.artifactFinalPath.startsWith(relocatedRoot),
      false,
      "relocated snapshot must not be mistaken for a supported rebase"
    );
    assert.equal(
      restoredPaths.profileDir.startsWith(relocatedRoot),
      false,
      "browser profile metadata remains absolute and source-rooted without a rebase"
    );
    assert.throws(() => readFileSync(restoredPaths.artifactFinalPath, "utf8"), {
      code: "ENOENT",
    });
    assert.throws(() => readFileSync(join(restoredPaths.profileDir, "restore-marker.txt"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    closeDb();
    clearCurrentBootEpoch();
    if (previousEnv.credentialKey === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = previousEnv.credentialKey;
    }
    if (previousEnv.credentialKeyFile === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV] = previousEnv.credentialKeyFile;
    }
    rmSync(durableRoot, { force: true, recursive: true });
    rmSync(snapshotRoot, { force: true, recursive: true });
    rmSync(relocatedRoot, { force: true, recursive: true });
  }
});
