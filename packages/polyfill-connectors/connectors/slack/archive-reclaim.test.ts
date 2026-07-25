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
import { createHash } from "node:crypto";
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

function scopedArchiveDigest(channels: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(channels)].sort()))
    .digest("hex")
    .slice(0, 12);
}

function seedArchiveSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE MESSAGE (
      CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER,
      TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL
    );
  `);
}

function insertChannel(db: DatabaseSync, id: string, name: string): void {
  db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    JSON.stringify({ is_channel: true, is_member: true, name }),
    1
  );
}

function insertMessage(db: DatabaseSync, channelId: string, ts: string, text: string): void {
  db.prepare(
    "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(channelId, ts, null, null, text, null, new TextEncoder().encode(JSON.stringify({ text, user: "U1" })), 1);
}

async function seedUploads(archiveDir: string, fileId: string, bytes: number): Promise<void> {
  const uploadsDir = join(archiveDir, "__uploads", fileId);
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(uploadsDir, "attachment.bin"), Buffer.alloc(bytes, 7));
}

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
    // Reclaim evidence MUST NOT be a stdout PROGRESS/JSONL message: by the time
    // onDurableCommit runs, the runtime has already consumed this run's DONE
    // and would reject any further stdout JSONL as "message after DONE",
    // failing an already-succeeded run. It goes to stderr instead. Matches the
    // specific reclaim-evidence phrase (not a bare "reclaim" substring, which
    // false-positives against this test's own "pdpp-slack-reclaim-on-*" tmpdir
    // prefix appearing inside unrelated archive-path PROGRESS messages).
    assert.ok(
      !result.rawStdout.includes("Slack reclaim: removed __uploads/"),
      "reclaim evidence is NOT emitted as a stdout PROGRESS message (would violate the DONE-then-silence protocol)"
    );
    assert.ok(
      result.stderr.includes("[onDurableCommit]") && result.stderr.includes("reclaim: removed __uploads/"),
      "reports the reclaim as stderr evidence"
    );
    assert.ok(result.stderr.includes("one-way"), "reclaim evidence states it is one-way/unrecoverable");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 reclaims __uploads/ in every archive the run actually read, not just the base archive", async () => {
  // Reproduces the auto-reconciliation path (reconcileMessageSourceCache):
  // C0MISSING disappeared from the base archive but a prior run's state still
  // lists it as observed, so the connector heals it from an existing scoped
  // archive at archive-scoped/<digest>/. Both the base archive and the scoped
  // archive have their own __uploads/ residue — a reclaim plan that only
  // tracks the base archive (the pre-fix behavior) leaves the scoped
  // archive's bytes stranded forever.
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-multi-"));
  try {
    const workspace = "reclaim-multi-ws";
    const baseArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const scopedArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(baseArchiveDir, { recursive: true });
    await mkdir(scopedArchiveDir, { recursive: true });

    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }
    const scopedDb = new DatabaseSync(join(scopedArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(scopedDb);
      insertChannel(scopedDb, "C0MISSING", "missing");
      insertMessage(scopedDb, "C0MISSING", "1714032850.123456", "recovered from scoped archive");
    } finally {
      scopedDb.close();
    }
    await seedUploads(baseArchiveDir, "F_BASE", 4096);
    await seedUploads(scopedArchiveDir, "F_SCOPED", 2048);

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "run healed the missing channel and succeeded");
    assert.ok(!existsSync(join(baseArchiveDir, "__uploads")), "base archive __uploads/ reclaimed");
    assert.ok(!existsSync(join(scopedArchiveDir, "__uploads")), "scoped archive __uploads/ ALSO reclaimed");
    assert.ok(existsSync(join(baseArchiveDir, "slackdump.sqlite")), "base sqlite (resume state) untouched");
    assert.ok(existsSync(join(scopedArchiveDir, "slackdump.sqlite")), "scoped sqlite (resume state) untouched");
    assert.ok(
      result.stderr.includes(baseArchiveDir) && result.stderr.includes("reclaimed 4096B"),
      "reports the base archive's reclaimed bytes"
    );
    assert.ok(
      result.stderr.includes(scopedArchiveDir) && result.stderr.includes("reclaimed 2048B"),
      "reports the scoped archive's reclaimed bytes"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 reclaims a repair archive that was successfully created/read but recovered no matching channel", async () => {
  // repairMissingScopedArchive can succeed (ensureArchiveOnDisk does not
  // throw — the archive genuinely exists on disk) while readArchiveChannelIds
  // finds no row matching the requested missing channel. Before this fix,
  // that path returned null from repairMissingScopedArchive and the archive
  // was silently excluded from reclaimPlan even though this run created/read
  // real bytes (including __uploads/) at that path. C0MISSING has NO existing
  // scoped archive covering it, so selectScopedArchivesForChannels returns []
  // and the repair attempt is forced; the pre-seeded repair-target archive
  // only contains an unrelated channel, so the repair "succeeds" but recovers
  // nothing.
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-empty-repair-"));
  try {
    const workspace = "reclaim-empty-repair-ws";
    const baseArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const repairArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(baseArchiveDir, { recursive: true });
    await mkdir(repairArchiveDir, { recursive: true });

    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }
    // Repair target exists (so ensureArchiveOnDisk succeeds under
    // PDPP_SLACK_SKIP_SLACKDUMP=1) but has no row for C0MISSING — an
    // unrelated channel only, modeling a repair that genuinely ran and read
    // real bytes but did not recover the channel it was attempting to heal.
    const repairDb = new DatabaseSync(join(repairArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(repairDb);
      insertChannel(repairDb, "C_UNRELATED", "unrelated");
    } finally {
      repairDb.close();
    }
    await seedUploads(baseArchiveDir, "F_BASE", 4096);
    await seedUploads(repairArchiveDir, "F_REPAIR_EMPTY", 1024);

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "run succeeded even though the repair recovered no channel");
    // The missing-channel diagnostic still fires (repair genuinely failed to
    // heal C0MISSING) — this test is about reclaim coverage, not suppressing
    // that honest signal.
    assert.ok(
      result.messages.some((m) => m.type === "SKIP_RESULT" && m.reason === "source_partition_missing"),
      "C0MISSING is still reported missing (repair did not recover it)"
    );
    assert.ok(!existsSync(join(baseArchiveDir, "__uploads")), "base archive __uploads/ reclaimed");
    assert.ok(
      !existsSync(join(repairArchiveDir, "__uploads")),
      "empty-repair archive __uploads/ ALSO reclaimed, despite recovering no matching channel"
    );
    assert.ok(existsSync(join(baseArchiveDir, "slackdump.sqlite")), "base sqlite untouched");
    assert.ok(existsSync(join(repairArchiveDir, "slackdump.sqlite")), "empty-repair sqlite untouched");
    assert.ok(
      result.stderr.includes(repairArchiveDir) && result.stderr.includes("reclaimed 1024B"),
      "reports the empty-repair archive's reclaimed bytes"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 does NOT reclaim a repair archive when the repair attempt itself fails before durable", async () => {
  // Preserves the failed-before-durable invariant for the empty-repair path
  // specifically: if ensureArchiveOnDisk throws (no archive at the repair
  // target and PDPP_SLACK_SKIP_SLACKDUMP=1), repairMissingScopedArchive
  // returns archivePath: null and nothing is added to the reclaim plan for
  // that path — there is nothing durable to reclaim, and the overall run
  // still succeeds (the repair failure is caught and reported as a
  // progress line, not a fatal error) since C0MISSING was already
  // optional-diagnostic, not required.
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-repair-fail-"));
  try {
    const workspace = "reclaim-repair-fail-ws";
    const baseArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(baseArchiveDir, { recursive: true });
    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }
    await seedUploads(baseArchiveDir, "F_BASE", 4096);
    // Deliberately do NOT create archive-scoped/<digest(["C0MISSING"])>/ — with
    // PDPP_SLACK_SKIP_SLACKDUMP=1 and no archive on disk, ensureArchiveOnDisk
    // throws for the repair attempt.

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "run still succeeds; the failed repair attempt is non-fatal");
    assert.ok(!existsSync(join(baseArchiveDir, "__uploads")), "base archive __uploads/ still reclaimed");
    const repairArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    assert.ok(!existsSync(repairArchiveDir), "failed repair attempt created no archive directory to reclaim");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile phase timing is reported when source-cache healing runs", async () => {
  // Before this fix, reconcileMessageSourceCache's own slackdump subprocess
  // calls (one per healed scoped archive) ran between the
  // slackdump-subprocess and read-and-emit phases but were not themselves
  // timed — their cost was silently absorbed into total run wall-clock,
  // invisible in run evidence.
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-timing-"));
  try {
    const workspace = "reconcile-timing-ws";
    const baseArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const scopedArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(baseArchiveDir, { recursive: true });
    await mkdir(scopedArchiveDir, { recursive: true });

    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }
    const scopedDb = new DatabaseSync(join(scopedArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(scopedDb);
      insertChannel(scopedDb, "C0MISSING", "missing");
      insertMessage(scopedDb, "C0MISSING", "1714032850.123456", "recovered from scoped archive");
    } finally {
      scopedDb.close();
    }

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
          },
        },
      },
    });

    const lines = progressLines(result.messages);
    assert.ok(
      lines.some((l) => l.includes("phase timing: scoped-archive-reconcile")),
      "reports scoped-archive-reconcile phase timing when healing runs"
    );
    // Elapsed-time phase timing alone is not a semantic bound — it says how
    // long the phase took, not how much work it could possibly do. The
    // following assert the actual finite bound: the repair-unit count is
    // stated BEFORE any subprocess runs (so it is a real upper bound on this
    // run's reconciliation work, not a post-hoc tally), a completed/remaining
    // cursor advances per unit, and the phase declares itself finished with 0
    // remaining. One scoped archive covers C0MISSING here, so no repair
    // attempt is needed: exactly 1 repair unit selected, 1 completed.
    assert.ok(
      lines.some((l) => /selected 1 repair unit\(s\)/.test(l) && l.includes("1 existing scoped archive refresh(es)")),
      "declares the exact repair-unit count before any subprocess runs"
    );
    assert.ok(
      lines.some((l) => l.includes("lookback=p7d")),
      "declares the per-unit finite lookback bound (SLACK_LOOKBACK_DAYS, default 7)"
    );
    assert.ok(
      lines.some((l) => l.includes("completed 1/1 repair unit(s)")),
      "reports a completed/remaining cursor advancing per repair unit"
    );
    assert.ok(
      lines.some((l) => l.includes("finished: 1/1 repair unit(s) completed, 0 remaining")),
      "declares the phase finished with 0 remaining — a single run cannot leave an open-ended backlog"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile declares 0 selected repair units and does no work when there is nothing to heal", async () => {
  // The bound must also be honest in the common case: no missing channel
  // means 0 repair units selected and 0 subprocess calls, not a phase that
  // silently runs "just in case".
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-none-"));
  try {
    const workspace = "reconcile-none-ws";
    const baseArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(baseArchiveDir, { recursive: true });
    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C1", "present");
      insertMessage(baseDb, "C1", "1714032849.123456", "hi");
    } finally {
      baseDb.close();
    }

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "d=fake",
        SLACK_TOKEN: "xoxc-fake",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C1: "1714032800.000000" },
            observed_channel_ids: ["C1"],
          },
        },
      },
    });

    const lines = progressLines(result.messages);
    assert.ok(
      lines.some((l) => /selected 0 repair unit\(s\)/.test(l)),
      "declares 0 repair units selected when no channel is missing"
    );
    assert.ok(
      lines.some((l) => l.includes("finished: 0/0 repair unit(s) completed, 0 remaining")),
      "finishes immediately with 0/0, proving no unbounded work was attempted"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
