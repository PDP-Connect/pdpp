// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createBrowserSurfaceReplacementLedger } from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import {
  artifactInput,
  parseArgs,
  parseArtifact,
  validateArgs,
} from "../scripts/repair/apply-browser-surface-replacement-correction.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { createPostgresBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";

const ARTIFACT = JSON.stringify({
  correction: {
    applied_at: "2026-07-30T00:00:00.000Z",
    episode: {
      first_event_seq: 2,
      first_observed_at: "2026-07-29T00:00:00.000Z",
      id: "reviewed-episode",
      last_event_seq: 2,
      last_observed_at: "2026-07-29T00:00:00.000Z",
    },
    members: [],
    prior_failed_replacement_id: "reviewed-predecessor",
    replacement_batch_id: "reviewed-batch",
  },
  version: 1,
});
const AMBIGUOUS_ACTION_ERROR = /at most one/;
const REVOKE_TIMESTAMP_ERROR = /requires --revoked-at/;
const MISSING_REQUIRED_TABLE_ERROR = /missing required table\(s\)/;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const execFileAsync = promisify(execFile);
const REFERENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("reviewed replacement correction accepts one exact artifact and derives its digest", () => {
  const parsed = parseArtifact(ARTIFACT);
  assert.equal(parsed.version, 1);
  assert.equal(artifactInput(ARTIFACT).reviewed_artifact_sha256.length, 64);
  assert.notEqual(
    artifactInput(`${ARTIFACT}\n`).reviewed_artifact_sha256,
    artifactInput(ARTIFACT).reviewed_artifact_sha256
  );
});

test("reviewed replacement correction refuses ambiguous maintenance actions", () => {
  assert.equal(validateArgs(parseArgs(["--artifact=episode.json"])), null);
  assert.match(
    validateArgs(parseArgs(["--artifact=episode.json", "--apply", "--verify"])) || "",
    AMBIGUOUS_ACTION_ERROR
  );
  assert.match(validateArgs(parseArgs(["--artifact=episode.json", "--revoke"])) || "", REVOKE_TIMESTAMP_ERROR);
});

test("CLI rejects same-named views before artifact validation", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const db = `pdpp_test_views_${process.pid}_${Date.now()}`.replaceAll("-", "_");
  const admin = new Pool({ connectionString: POSTGRES_URL });
  const dir = mkdtempSync(join(tmpdir(), "pdpp-views-"));
  const artifact = join(dir, "artifact.json");
  try {
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(POSTGRES_URL);
    url.pathname = `/${db}`;
    const views = new Pool({ connectionString: url.toString() });
    try {
      await Promise.all(
        [
          "browser_surface_replacement_receipts",
          "browser_surface_replacement_selection_overrides",
          "browser_surface_replacement_selection_override_batches",
          "browser_surface_replacement_selection_override_audit_outbox",
          "spine_events",
        ].map((name) => views.query(`CREATE VIEW ${name} AS SELECT 1 AS placeholder`))
      );
    } finally {
      await views.end();
    }
    writeFileSync(artifact, JSON.stringify({ correction: {}, version: 1 }));
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/repair/apply-browser-surface-replacement-correction.ts",
            `--artifact=${artifact}`,
          ],
          { cwd: REFERENCE_ROOT, env: { ...process.env, PDPP_DATABASE_URL: url.toString() }, timeout: 5000 }
        ),
      MISSING_REQUIRED_TABLE_ERROR
    );
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI dry-run and verify bypass a held bootstrap lock without schema/data changes", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const n = `cli-lock-${process.pid}-${Date.now()}`;
  const d = mkdtempSync(join(tmpdir(), "pdpp-cli-"));
  const f = join(d, "a.json");
  const lock = new Pool({ connectionString: POSTGRES_URL });
  const ledger = createBrowserSurfaceReplacementLedger({ idPrefix: n, now: () => "2026-07-30T00:00:00.000Z" });
  try {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    const store = createPostgresBrowserSurfaceReplacementReceiptStore();
    const prior = await store.append(
      ledger.start({
        cause: "external_or_host_loss",
        connection_id: `${n}-c`,
        connector_id: "chatgpt",
        idempotency_key: `${n}-p`,
        observed_at: "2026-07-29T21:07:58.000Z",
        profile_key: `${n}-p`,
        surface_id: `${n}-p`,
        surface_subject_id: `${n}-s`,
      })
    );
    await store.append(
      ledger.terminate({
        cause: prior.cause,
        connection_id: prior.connection_id,
        outcome: "failed",
        profile_key: prior.profile_key,
        replacement_id: prior.replacement_id,
        surface_id: prior.surface_id ?? "",
        surface_subject_id: `${n}-s`,
      })
    );
    const member = await store.append(
      ledger.start({
        cause: "external_or_host_loss",
        connection_id: prior.connection_id,
        connector_id: "chatgpt",
        idempotency_key: `${n}-m`,
        observed_at: "2026-07-29T21:07:59.000Z",
        profile_key: prior.profile_key,
        surface_id: `${n}-m`,
        surface_subject_id: `${n}-s`,
      })
    );
    const a = {
      correction: {
        applied_at: "2026-07-30T00:00:00.000Z",
        episode: {
          first_event_seq: member.event_seq,
          first_observed_at: member.observed_at,
          id: `${n}-e`,
          last_event_seq: member.event_seq,
          last_observed_at: member.observed_at,
        },
        members: [
          {
            connection_id: member.connection_id,
            connector_id: member.connector_id ?? null,
            event_seq: member.event_seq,
            idempotency_key: member.idempotency_key,
            observed_at: member.observed_at,
            profile_key: member.profile_key,
            replacement_id: member.replacement_id,
            scope: member.scope,
            surface_id: member.surface_id ?? "",
            surface_subject_id: member.surface_subject_id ?? null,
          },
        ],
        prior_failed_replacement_id: prior.replacement_id,
        replacement_batch_id: `${n}-b`,
      },
      version: 1,
    };
    writeFileSync(f, JSON.stringify(a));
    const c = await lock.connect();
    try {
      await c.query("SELECT pg_advisory_lock(482571,150)");
      const args = [
        "--import",
        "tsx",
        "scripts/repair/apply-browser-surface-replacement-correction.ts",
        `--artifact=${f}`,
      ];
      const run = await execFileAsync(process.execPath, args, {
        cwd: REFERENCE_ROOT,
        env: { ...process.env, PDPP_DATABASE_URL: POSTGRES_URL },
        timeout: 5000,
      });
      assert.equal(JSON.parse(run.stdout).active, false);
      await store.applySelectionOverrideBatch({
        ...a.correction,
        reviewed_artifact_sha256: artifactInput(JSON.stringify(a)).reviewed_artifact_sha256,
      });
      const verify = await execFileAsync(process.execPath, [...args, "--verify"], {
        cwd: REFERENCE_ROOT,
        env: { ...process.env, PDPP_DATABASE_URL: POSTGRES_URL },
        timeout: 5000,
      });
      assert.equal(JSON.parse(verify.stdout).active, true);
    } finally {
      await c.query("SELECT pg_advisory_unlock(482571,150)");
      c.release();
    }
  } finally {
    await closePostgresStorage();
    await lock.end();
    rmSync(d, { force: true, recursive: true });
  }
});
