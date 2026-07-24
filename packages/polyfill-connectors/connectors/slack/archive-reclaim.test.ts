// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Covers the archive steady-state-cost change's disk + observability surface:
// - reclaimUploads removes ONLY __uploads/, leaves sqlite + sidecars, reports
//   bytes, and is a no-op when the dir is absent (direct unit test).
// - the connector emits phase-timing + archive-size PROGRESS lines every run.
// - __uploads reclaim is off by default and, when SLACK_RECLAIM_UPLOADS=1, runs
//   only after a successful run's durable-commit ack (end-to-end subprocess).
// All fixtures are synthetic — no private payloads.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { reclaimUploads } from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const SLACK_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "slack", "index.ts");

async function seedArchive(homeDir: string, workspace: string, withUploads: boolean): Promise<string> {
  const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
  await mkdir(archiveDir, { recursive: true });
  const sqlitePath = join(archiveDir, "slackdump.sqlite");
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE MESSAGE (
        CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER,
        TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "C1",
      "1714032849.123456",
      null,
      null,
      "hi",
      null,
      new TextEncoder().encode(JSON.stringify({ text: "hi", user: "U1" })),
      1
    );
  } finally {
    db.close();
  }
  if (withUploads) {
    const uploadsDir = join(archiveDir, "__uploads", "F123");
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, "attachment.bin"), Buffer.alloc(4096, 7));
  }
  return archiveDir;
}

test("reclaimUploads removes only __uploads/, leaves sqlite + sidecars, reports bytes", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-unit-"));
  try {
    const archiveDir = await seedArchive(homeDir, "ws", true);
    const sqlitePath = join(archiveDir, "slackdump.sqlite");
    await writeFile(`${sqlitePath}-wal`, Buffer.alloc(128, 1));
    await writeFile(`${sqlitePath}-shm`, Buffer.alloc(64, 1));

    assert.ok(existsSync(join(archiveDir, "__uploads")), "precondition: __uploads exists");

    const reclaimed = await reclaimUploads(archiveDir);

    assert.equal(reclaimed, 4096, "reports the reclaimed byte count");
    assert.ok(!existsSync(join(archiveDir, "__uploads")), "__uploads removed");
    assert.ok(existsSync(sqlitePath), "sqlite untouched");
    assert.ok(existsSync(`${sqlitePath}-wal`), "-wal sidecar untouched");
    assert.ok(existsSync(`${sqlitePath}-shm`), "-shm sidecar untouched");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("reclaimUploads is a no-op returning 0 when __uploads/ is absent", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-absent-"));
  try {
    const archiveDir = await seedArchive(homeDir, "ws", false);
    const reclaimed = await reclaimUploads(archiveDir);
    assert.equal(reclaimed, 0);
    assert.ok(existsSync(join(archiveDir, "slackdump.sqlite")), "sqlite untouched");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

function progressLines(messages: EmittedMessage[]): string[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS")
    .map((m) => (m as { message?: string }).message ?? "");
}

test("connector emits phase-timing and archive-size PROGRESS every run", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-timing-"));
  try {
    await seedArchive(homeDir, "timing-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: "timing-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const lines = progressLines(result.messages);
    assert.ok(
      lines.some((l) => l.includes("phase timing: slackdump-subprocess")),
      "reports slackdump-subprocess phase timing"
    );
    assert.ok(
      lines.some((l) => l.includes("phase timing: archive-open")),
      "reports archive-open phase timing"
    );
    assert.ok(
      lines.some((l) => l.includes("phase timing: read-and-emit")),
      "reports read-and-emit phase timing"
    );
    assert.ok(
      lines.some((l) => l.includes("archive size: sqlite=")),
      "reports archive size snapshot"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("__uploads reclaim is OFF by default: a normal run leaves __uploads intact", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-off-"));
  try {
    const archiveDir = await seedArchive(homeDir, "off-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: "off-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded");
    assert.ok(existsSync(join(archiveDir, "__uploads")), "__uploads NOT reclaimed without opt-in");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 does NOT reclaim when the run fails (gate honored)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-fail-"));
  try {
    // Seed __uploads but NO sqlite: with PDPP_SLACK_SKIP_SLACKDUMP=1 and a
    // missing archive, the connector fails before durable commit.
    const archiveDir = join(homeDir, ".pdpp", "slackdump", "fail-ws", "archive");
    await mkdir(join(archiveDir, "__uploads", "F1"), { recursive: true });
    await writeFile(join(archiveDir, "__uploads", "F1", "a.bin"), Buffer.alloc(2048, 3));

    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: "fail-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "failed", "run failed (no archive)");
    assert.ok(existsSync(join(archiveDir, "__uploads")), "__uploads intact: reclaim never precedes a durable commit");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 removes __uploads after a successful run, sqlite intact", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-on-"));
  try {
    const archiveDir = await seedArchive(homeDir, "on-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: "on-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "run succeeded (reclaim runs post-commit)");
    assert.ok(!existsSync(join(archiveDir, "__uploads")), "__uploads reclaimed after durable commit");
    assert.ok(existsSync(join(archiveDir, "slackdump.sqlite")), "sqlite (resume state) untouched");
    const reclaimLine = progressLines(result.messages).find((l) => l.includes("reclaim: removed __uploads/"));
    assert.ok(reclaimLine, "reports the reclaim as run evidence");
    assert.ok(reclaimLine?.includes("one-way"), "reclaim evidence states it is one-way/unrecoverable");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
