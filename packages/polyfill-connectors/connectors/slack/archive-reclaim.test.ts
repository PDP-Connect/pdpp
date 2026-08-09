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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConnectorArtifactDir } from "../../src/connector-artifact-root.ts";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { reclaimUploads } from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const SLACK_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "slack", "index.ts");

/**
 * Where the connector will look for `<workspace>`'s archive, derived from the
 * SAME resolver the connector uses so these tests pin the seam rather than
 * re-encoding the on-disk layout. Tests own the root via
 * `PDPP_CONNECTOR_ARTIFACT_ROOT`; the connector no longer derives it from the
 * home directory (see src/connector-artifact-root.ts).
 */
function seedArchiveRoot(artifactRoot: string, workspace: string): string {
  return resolveConnectorArtifactDir("slack", [workspace], {
    PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
  }).root;
}

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

async function seedArchive(artifactRoot: string, workspace: string, withUploads: boolean): Promise<string> {
  const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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

function messagesState(result: { messages: EmittedMessage[] }): Record<string, unknown> {
  const state = result.messages.findLast(
    (message): message is Extract<EmittedMessage, { type: "STATE" }> =>
      message.type === "STATE" && message.stream === "messages"
  );
  assert.ok(state, "expected messages STATE");
  assert.equal(typeof state.cursor, "object");
  assert.notEqual(state.cursor, null);
  return state.cursor as Record<string, unknown>;
}

test("reclaimUploads removes only __uploads/, leaves sqlite + sidecars, reports bytes", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-unit-"));
  try {
    const archiveDir = await seedArchive(artifactRoot, "ws", true);
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("base archive resume is throttled on the 90-minute follow-up without invoking slackdump", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-base-throttle-immediate-"));
  try {
    const workspace = "base-throttle-immediate-ws";
    const archiveDir = await seedArchive(artifactRoot, workspace, false);
    const fakeSlackdump = await writeCountingSlackdump(artifactRoot);
    const resumedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: baseArchiveState(archiveDir, resumedAt),
      },
    });

    assert.ok(
      progressLines(result.messages).some(
        (line) => line.includes("base archive at") && line.includes("not due for resume yet")
      )
    );
    assert.ok(!existsSync(fakeSlackdump.callLog), "the follow-up launched zero slackdump resume subprocesses");
    assert.equal(
      (messagesState(result).base_archive_resumed_at as Record<string, string> | undefined)?.[archiveDir],
      resumedAt,
      "the successful base-resume fact is carried forward unchanged while throttled"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a failed base archive resume remains owed and retries successfully on the next run", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-base-throttle-retry-"));
  try {
    const workspace = "base-throttle-retry-ws";
    const archiveDir = await seedArchive(artifactRoot, workspace, false);
    const fakeSlackdump = await writeCountingSlackdump(artifactRoot, true);
    const options = {
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START" as const,
        scope: { streams: [{ name: "messages" }] },
        state: baseArchiveState(archiveDir),
      },
    };
    const failed = await runConnectorProtocolSubprocess({ ...options, allowFailedDone: true });
    assert.equal(failed.messages.findLast((message) => message.type === "DONE")?.status, "failed");
    assert.ok(!failed.messages.some((message) => message.type === "STATE"), "a failed run commits no success cursor");

    const recovered = await runConnectorProtocolSubprocess(options);
    const calls = (await readFile(fakeSlackdump.callLog, "utf8")).trim().split("\n");
    assert.equal(calls.length, 2, "the next run retried the failed base resume instead of suppressing it");
    assert.ok(
      calls.every((call) => call.startsWith("resume ")),
      "both attempts were base resume invocations"
    );
    assert.ok(
      (messagesState(recovered).base_archive_resumed_at as Record<string, string> | undefined)?.[archiveDir],
      "only the successful retry writes the base archive success cursor"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("base archive resume runs again after the seven-day lookback expires", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-base-throttle-expiry-"));
  try {
    const workspace = "base-throttle-expiry-ws";
    const archiveDir = await seedArchive(artifactRoot, workspace, false);
    const fakeSlackdump = await writeCountingSlackdump(artifactRoot);
    const staleResumedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: baseArchiveState(archiveDir, staleResumedAt),
      },
    });

    assert.match(await readFile(fakeSlackdump.callLog, "utf8"), /^resume /, "an expired base cursor resumes again");
    assert.notEqual(
      (messagesState(result).base_archive_resumed_at as Record<string, string> | undefined)?.[archiveDir],
      staleResumedAt,
      "a successful due resume advances the base archive success cursor"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("upgrade compatibility: a pre-upgrade successful base archive is throttled on the first post-upgrade run, not replayed", async () => {
  // Reproduces the live pre-upgrade STATE shape exactly: a workspace whose
  // base archive already completed real, successful resumes under the OLD
  // code (proven by durably-committed `channel_last_ts`/`archive_dir` —
  // fields only ever written by a run that reached its normal STATE commit),
  // but with NO `base_archive_resumed_at` entry, because that field did not
  // exist yet. Live evidence: deployed b7a6485f5/674eccb6e's first
  // post-upgrade run (run_1784994300807) logged "Resuming slackdump at
  // /root/.pdpp/slackdump/vana-org/archive" despite this being an
  // already-successful, steady-state connection — a fresh ~4.6GB replay the
  // throttle was supposed to prevent. This test fails against the code as
  // shipped in b7a6485f5 (undefined base_archive_resumed_at entry reads as
  // "due") and must pass once the migration/derivation closes the gap.
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-base-throttle-migration-"));
  try {
    const workspace = "base-throttle-migration-ws";
    const archiveDir = await seedArchive(artifactRoot, workspace, false);
    const fakeSlackdump = await writeCountingSlackdump(artifactRoot);
    const preUpgradeState = {
      messages: {
        archive_dir: archiveDir,
        channel_last_ts: { C1: "1714032849.123456" },
        last_ts: "1714032849.123456",
        // No base_archive_resumed_at key at all — the exact pre-upgrade shape.
      },
    };

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: preUpgradeState,
      },
    });

    assert.ok(
      !existsSync(fakeSlackdump.callLog),
      "the first post-upgrade run launched zero slackdump resume subprocesses"
    );
    const migratedAt = (messagesState(result).base_archive_resumed_at as Record<string, string> | undefined)?.[
      archiveDir
    ];
    assert.ok(migratedAt, "a synthetic base_archive_resumed_at fact is derived and committed for the next run");

    // The immediate 90-minute follow-up (the schedule the live canary uses)
    // must ALSO stay throttled off the derived fact, not just this run.
    const followUp = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: { messages: { ...preUpgradeState.messages, base_archive_resumed_at: { [archiveDir]: migratedAt } } },
      },
    });
    assert.ok(
      !existsSync(fakeSlackdump.callLog),
      "the 90-minute follow-up after migration also launched zero slackdump resume subprocesses"
    );
    assert.equal(
      (messagesState(followUp).base_archive_resumed_at as Record<string, string> | undefined)?.[archiveDir],
      migratedAt,
      "the derived fact is carried forward unchanged on the follow-up run"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("upgrade compatibility does NOT seed the throttle from archive existence alone (interrupted/failed prior run)", async () => {
  // The negative case the migration must not conflate with success: an
  // archive directory that exists on disk (a timed-out or crashed prior run
  // can leave one behind, per pickResumeTarget's own doc comment) but with
  // NO durably-committed channel_last_ts/last_ts proof and NO
  // base_archive_resumed_at fact. This must resume normally, exactly like
  // today's pre-migration first-run behavior — seeding from mere existence
  // would silently mask a prior run that never actually finished.
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-base-throttle-no-seed-"));
  try {
    const workspace = "base-throttle-no-seed-ws";
    const archiveDir = await seedArchive(artifactRoot, workspace, false);
    const fakeSlackdump = await writeCountingSlackdump(artifactRoot);

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdump.path,
        TEST_SLACKDUMP_CALL_LOG: fakeSlackdump.callLog,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: { messages: { archive_dir: archiveDir } },
      },
    });

    assert.match(
      await readFile(fakeSlackdump.callLog, "utf8"),
      /^resume /,
      "an archive with no proven-successful prior run still resumes, not throttled from existence alone"
    );
    assert.ok(
      (messagesState(result).base_archive_resumed_at as Record<string, string> | undefined)?.[archiveDir],
      "a genuinely completed resume this run still stamps the real success fact"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("reclaimUploads is a no-op returning 0 when __uploads/ is absent", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-absent-"));
  try {
    const archiveDir = await seedArchive(artifactRoot, "ws", false);
    const reclaimed = await reclaimUploads(archiveDir);
    assert.equal(reclaimed, 0);
    assert.ok(existsSync(join(archiveDir, "slackdump.sqlite")), "sqlite untouched");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

function progressLines(messages: EmittedMessage[]): string[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS")
    .map((m) => (m as { message?: string }).message ?? "");
}

async function writeCountingSlackdump(
  artifactRoot: string,
  failFirst = false
): Promise<{ callLog: string; path: string }> {
  const path = join(artifactRoot, "fake-slackdump.mjs");
  const callLog = join(artifactRoot, "slackdump-calls.log");
  const failedMarker = join(artifactRoot, "slackdump-first-failure.marker");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const isResume = process.argv[2] === "resume";
if (isResume) writeFileSync(process.env.TEST_SLACKDUMP_CALL_LOG, process.argv.slice(2).join(" ") + "\\n", { flag: "a" });
if (isResume && ${String(failFirst)} && !existsSync(${JSON.stringify(failedMarker)})) {
  writeFileSync(${JSON.stringify(failedMarker)}, "failed");
  process.exit(6);
}
process.exit(0);
`,
    "utf8"
  );
  await chmod(path, 0o755);
  return { callLog, path };
}

function baseArchiveState(archivePath: string, baseArchiveResumedAt?: string): Record<string, unknown> {
  return {
    messages: {
      archive_dir: archivePath,
      ...(baseArchiveResumedAt ? { base_archive_resumed_at: { [archivePath]: baseArchiveResumedAt } } : {}),
    },
  };
}

test("connector emits phase-timing and archive-size PROGRESS every run", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-timing-"));
  try {
    await seedArchive(artifactRoot, "timing-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("__uploads reclaim is OFF by default: a normal run leaves __uploads intact", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-off-"));
  try {
    const archiveDir = await seedArchive(artifactRoot, "off-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: "off-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded");
    assert.ok(existsSync(join(archiveDir, "__uploads")), "__uploads NOT reclaimed without opt-in");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 does NOT reclaim when the run fails (gate honored)", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-fail-"));
  try {
    // Seed __uploads but NO sqlite: with PDPP_SLACK_SKIP_SLACKDUMP=1 and a
    // missing archive, the connector fails before durable commit.
    const archiveDir = join(seedArchiveRoot(artifactRoot, "fail-ws"), "archive");
    await mkdir(join(archiveDir, "__uploads", "F1"), { recursive: true });
    await writeFile(join(archiveDir, "__uploads", "F1", "a.bin"), Buffer.alloc(2048, 3));

    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: "fail-ws",
      },
      start: { type: "START", scope: { streams: [{ name: "messages" }] } },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "failed", "run failed (no archive)");
    assert.ok(existsSync(join(archiveDir, "__uploads")), "__uploads intact: reclaim never precedes a durable commit");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("SLACK_RECLAIM_UPLOADS=1 removes __uploads after a successful run, sqlite intact", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-on-"));
  try {
    const archiveDir = await seedArchive(artifactRoot, "on-ws", true);
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
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
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-multi-"));
  try {
    const workspace = "reclaim-multi-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
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
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-empty-repair-"));
  try {
    const workspace = "reclaim-empty-repair-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const repairArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
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
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reclaim-repair-fail-"));
  try {
    const workspace = "reclaim-repair-fail-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      seedArchiveRoot(artifactRoot, workspace),
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    assert.ok(!existsSync(repairArchiveDir), "failed repair attempt created no archive directory to reclaim");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile phase timing is reported when source-cache healing runs", async () => {
  // Before this fix, reconcileMessageSourceCache's own slackdump subprocess
  // calls (one per healed scoped archive) ran between the
  // slackdump-subprocess and read-and-emit phases but were not themselves
  // timed — their cost was silently absorbed into total run wall-clock,
  // invisible in run evidence.
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-timing-"));
  try {
    const workspace = "reconcile-timing-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      lines.some(
        (l) => /selected 1 repair unit\(s\)/.test(l) && l.includes("1 existing scoped archive(s), 1 due for resume")
      ),
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile declares 0 selected repair units and does no work when there is nothing to heal", async () => {
  // The bound must also be honest in the common case: no missing channel
  // means 0 repair units selected and 0 subprocess calls, not a phase that
  // silently runs "just in case".
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-none-"));
  try {
    const workspace = "reconcile-none-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

// Reproduces a live incident: a scoped archive covering exactly one
// permanently-missing channel (0 uncovered channels — fully covered by an
// EXISTING scoped archive every run) still got a full `slackdump resume`
// re-sync every single connector run, taking ~55 minutes against a large
// (multi-GB, multi-million-message) accumulated archive, forever — because
// "this archive is selected to cover a missing channel" was treated as
// sufficient reason to resume it, with no check for whether a resume could
// possibly discover anything new since the last one.
test("scoped-archive-reconcile throttles a scoped archive's resume to at most once per lookback window", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-throttle-"));
  try {
    const workspace = "reconcile-throttle-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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

    const recentlyResumedAt = new Date().toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
            // Already resumed moments ago — well within the default p7d
            // lookback. A fresh resume this run cannot discover anything a
            // resume next week (once genuinely due again) wouldn't also
            // catch, since -lookback bounds how far back either call can see.
            scoped_archive_resumed_at: { [scopedArchiveDir]: recentlyResumedAt },
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "run still succeeds when a scoped archive is throttled");
    const lines = progressLines(result.messages);
    assert.ok(
      lines.some(
        (l) => /selected 1 repair unit\(s\)/.test(l) && l.includes("1 existing scoped archive(s), 0 due for resume")
      ),
      "reports the archive as selected but NOT due for resume"
    );
    assert.ok(
      lines.some((l) => l.includes("not due for resume yet") && l.includes(scopedArchiveDir)),
      "explicitly reports the throttle decision for this archive"
    );
    // The decisive proof: ensureArchiveOnDisk's own "Skipping slackdump
    // refresh (PDPP_SLACK_SKIP_SLACKDUMP=1); reading existing archive at
    // <path>" line — which only fires when ensureArchiveOnDisk is actually
    // invoked — must NOT appear for the scoped archive path, because the
    // throttle short-circuits BEFORE ensureArchiveOnDisk is ever called.
    assert.ok(
      !lines.some((l) => l.includes("reading existing archive at") && l.includes(scopedArchiveDir)),
      "the scoped archive's resume subprocess path is never invoked when throttled (not merely fast — genuinely skipped)"
    );
    assert.ok(
      lines.some((l) => l.includes("completed 1/1 repair unit(s) (throttled, not owed)")),
      "the completed cursor reports this unit as throttled, not resumed"
    );
    const cursor = messagesState(result);
    assert.equal(
      (cursor.scoped_archive_resumed_at as Record<string, string> | undefined)?.[scopedArchiveDir],
      recentlyResumedAt,
      "a throttled archive's resumed_at timestamp is carried forward unchanged, not bumped to now"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile resumes a scoped archive again once its lookback throttle window has elapsed", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-due-"));
  try {
    const workspace = "reconcile-due-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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

    // 8 days ago: past the default SLACK_LOOKBACK_DAYS=7 throttle window.
    const staleResumedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
            scoped_archive_resumed_at: { [scopedArchiveDir]: staleResumedAt },
          },
        },
      },
    });

    const lines = progressLines(result.messages);
    assert.ok(
      lines.some(
        (l) => /selected 1 repair unit\(s\)/.test(l) && l.includes("1 existing scoped archive(s), 1 due for resume")
      ),
      "reports the archive as due for resume once the throttle window has elapsed"
    );
    assert.ok(
      lines.some((l) => l.includes("reading existing archive at") && l.includes(scopedArchiveDir)),
      "ensureArchiveOnDisk IS invoked for a genuinely due scoped archive — real remaining gaps still resume"
    );
    assert.ok(
      lines.some((l) => l.includes("completed 1/1 repair unit(s) (resumed)")),
      "the completed cursor reports this unit as actually resumed"
    );
    const cursor = messagesState(result);
    const newResumedAt = (cursor.scoped_archive_resumed_at as Record<string, string> | undefined)?.[scopedArchiveDir];
    assert.ok(
      newResumedAt && newResumedAt !== staleResumedAt,
      "resumed_at is bumped to this run's time after a real resume"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

// RI-owner LIVE REVISE, same incident: refreshScopedArchive's catch block
// returned `resumed: true` on a FAILED ensureArchiveOnDisk call, so a failed
// resume silently advanced scoped_archive_resumed_at and suppressed retries
// for the full lookback window — hiding a recoverable gap for up to 7 days
// with no typed evidence anywhere. This test drives the REAL (non-skip)
// slackdump invocation path via a fake SLACKDUMP_BIN that fails only for the
// scoped archive's path (succeeds for the base archive), so the failure is
// genuine subprocess failure, not a test-harness shortcut.
test("a failed scoped-archive resume does not advance the success cursor, emits a typed retryable gap, and leaves the archive owed for the next governor-allowed run", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-resume-fail-"));
  const priorBin = process.env.SLACKDUMP_BIN;
  try {
    const workspace = "reconcile-resume-fail-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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

    // Fake slackdump binary: exits non-zero ONLY when its last argument
    // (the archive/resume target path) is the scoped archive — the base
    // archive's own invocation succeeds (both sqlites already exist on disk
    // from the seeding above, so a no-op success is a valid "did nothing new
    // but completed cleanly" outcome for the base archive).
    const fakeSlackdumpPath = join(artifactRoot, "fake-slackdump.mjs");
    await writeFile(
      fakeSlackdumpPath,
      `#!/usr/bin/env node
const target = process.argv.at(-1) ?? "";
if (target.includes("archive-scoped")) {
  process.stderr.write("simulated: slackdump resume failed for scoped archive\\n");
  process.exit(6);
}
process.exit(0);
`,
      "utf8"
    );
    await chmod(fakeSlackdumpPath, 0o755);
    process.env.SLACKDUMP_BIN = fakeSlackdumpPath;

    const priorResumedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdumpPath,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
            // Stale (past the lookback window) so this archive is due for
            // resume this run — otherwise the throttle itself would skip the
            // subprocess and there would be nothing to fail.
            scoped_archive_resumed_at: { [scopedArchiveDir]: priorResumedAt },
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "a failed optional scoped-archive resume is non-fatal to the run");

    const lines = progressLines(result.messages);
    assert.ok(
      lines.some((l) => l.includes("scoped archive refresh failed") && l.includes("channel(s)")),
      "reports the resume failure as progress evidence"
    );
    assert.ok(
      lines.some((l) => l.includes("completed 1/1 repair unit(s) (failed, gap recorded)")),
      "the completed cursor honestly reports this unit as failed, not resumed"
    );

    // The decisive fix: the STATE cursor must NOT advance on failure. If it
    // did, the archive would be silently treated as caught-up for a full
    // lookback window despite the resume having accomplished nothing.
    const cursor = messagesState(result);
    const resumedAtAfter = (cursor.scoped_archive_resumed_at as Record<string, string> | undefined)?.[scopedArchiveDir];
    assert.equal(
      resumedAtAfter,
      priorResumedAt,
      "a failed resume leaves scoped_archive_resumed_at UNCHANGED — success and failure must never be conflated"
    );

    // Typed, durable recovery evidence — not a connector-local suppression
    // window — surfaces the failure so the existing gap/recovery-governor
    // path paces the retry.
    const gap = result.messages.find(
      (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
        m.type === "DETAIL_GAP" && (m as { record_key?: unknown }).record_key === scopedArchiveDir
    );
    assert.ok(gap, "emits a DETAIL_GAP keyed by the archive path");
    assert.equal(gap?.stream, "messages");
    assert.equal(gap?.reason, "temporary_unavailable");
    assert.equal(gap?.retryable, true);
    assert.equal(gap?.status, "pending");
    assert.equal((gap?.detail_locator as { kind?: unknown } | undefined)?.kind, "slack.scoped_archive_resume");
    assert.ok(
      !result.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
      "does not emit DETAIL_GAP_RECOVERED for a resume that never succeeded"
    );
  } finally {
    if (priorBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = priorBin;
    }
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("scoped-archive-reconcile emits DETAIL_GAP_RECOVERED when a previously-failed archive resumes successfully", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-recovered-"));
  try {
    const workspace = "reconcile-recovered-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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

    const staleResumedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
            scoped_archive_resumed_at: { [scopedArchiveDir]: staleResumedAt },
          },
        },
        // A prior run's failed attempt left this durable gap pending —
        // supplied here exactly as the runtime would replay it on START.
        detail_gaps: [
          {
            gap_id: "gap_prior_scoped_archive_resume",
            record_key: scopedArchiveDir,
            status: "pending",
            stream: "messages",
          },
        ],
      },
    });

    const recovered = result.messages.find(
      (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> => m.type === "DETAIL_GAP_RECOVERED"
    );
    assert.ok(recovered, "emits DETAIL_GAP_RECOVERED once the archive resumes successfully again");
    assert.equal(recovered?.gap_id, "gap_prior_scoped_archive_resume");
    assert.equal(recovered?.record_key, scopedArchiveDir);
    assert.equal(recovered?.stream, "messages");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

// RI final gate: round 5's fix covered ONLY the existing-archive-refresh
// failure path (refreshScopedArchive). repairMissingScopedArchive — the
// separate new-repair-attempt path for an UNCOVERED missing channel (no
// existing scoped archive selects it) — has its own ensureArchiveOnDisk
// failure branch that withheld the timestamp (already correct) but emitted
// no typed DETAIL_GAP at all, leaving this failure invisible to the
// recovery governor. This test drives the REAL (non-skip) slackdump path
// via a fake SLACKDUMP_BIN that fails only for the repair-target archive
// path (the base archive succeeds), with NO existing scoped archive for
// C0MISSING on disk — forcing reconcileMessageSourceCache into the
// new-repair-attempt branch, not the existing-archive-refresh branch.
test("a failed NEW-repair attempt for an uncovered missing channel emits the same typed retryable gap and leaves the archive owed", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-repair-fail-"));
  const priorBin = process.env.SLACKDUMP_BIN;
  try {
    const workspace = "reconcile-repair-fail-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const repairArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(baseArchiveDir, { recursive: true });
    // Deliberately do NOT create repairArchiveDir — no existing scoped
    // archive covers C0MISSING, so selectScopedArchivesForChannels selects
    // nothing for it and reconcileMessageSourceCache falls through to the
    // new-repair-attempt branch (repairMissingScopedArchive), not the
    // existing-archive-refresh branch (refreshScopedArchive).

    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }

    // Fake slackdump binary: exits non-zero ONLY when its last argument (the
    // archive/resume target path) is the repair-target archive — the base
    // archive's own invocation succeeds. Before failing, it writes a
    // partial __uploads/ file at the repair target — modeling a real
    // slackdump crash mid-dump that leaves residue on disk despite the run
    // never durably completing, so the reclaim gate has real bytes to
    // (correctly) refuse to touch.
    // The new-repair attempt runs slackdump's "archive" subcommand (not
    // "resume" — there is no existing archive on disk yet), whose args end
    // with the target's positional CHANNEL IDs, not the archive path itself
    // (unlike "resume", where the path IS the last arg). The archive path
    // instead follows the "-o" flag, so the fake binary locates it there.
    const fakeSlackdumpPath = join(artifactRoot, "fake-slackdump.mjs");
    await writeFile(
      fakeSlackdumpPath,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const oIndex = process.argv.indexOf("-o");
const target = oIndex >= 0 ? (process.argv[oIndex + 1] ?? "") : "";
if (target.includes("archive-scoped")) {
  const uploadsDir = join(target, "__uploads", "F_PARTIAL");
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, "partial.bin"), Buffer.alloc(512, 9));
  process.stderr.write("simulated: slackdump archive failed for new-repair attempt\\n");
  process.exit(6);
}
process.exit(0);
`,
      "utf8"
    );
    await chmod(fakeSlackdumpPath, 0o755);
    process.env.SLACKDUMP_BIN = fakeSlackdumpPath;

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        SLACK_COOKIE: "xoxd-fake",
        SLACK_RECLAIM_UPLOADS: "1",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
        SLACKDUMP_BIN: fakeSlackdumpPath,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
        state: {
          messages: {
            last_ts: "1714032800.000000",
            channel_last_ts: { C0MISSING: "1714032800.000000", C0PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
            // No prior scoped_archive_resumed_at entry for the repair path
            // — there is no existing archive to have a prior timestamp yet.
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "succeeded", "a failed optional new-repair attempt is non-fatal to the run");

    const lines = progressLines(result.messages);
    assert.ok(
      lines.some((l) => l.includes("scoped archive auto-reconcile failed") && l.includes("channel(s)")),
      "reports the new-repair failure as progress evidence"
    );
    assert.ok(
      lines.some((l) => l.includes("(failed, gap recorded)")),
      "the completed cursor honestly reports the new-repair attempt as failed, not resumed — SAME label as the existing-archive-refresh path, not a parallel taxonomy"
    );

    // The decisive fix: a failed new-repair attempt must NOT stamp a
    // scoped_archive_resumed_at entry for the repair-target path — there was
    // no prior entry, and none must appear now.
    const cursor = messagesState(result);
    const resumedAtAfter = (cursor.scoped_archive_resumed_at as Record<string, string> | undefined)?.[repairArchiveDir];
    assert.equal(
      resumedAtAfter,
      undefined,
      "a failed new-repair attempt records NO scoped_archive_resumed_at entry — it must remain owed, not silently marked done"
    );

    // Typed, durable recovery evidence — the SAME gap shape the
    // existing-archive-refresh path uses, keyed to the repair archive path.
    const gap = result.messages.find(
      (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
        m.type === "DETAIL_GAP" && (m as { record_key?: unknown }).record_key === repairArchiveDir
    );
    assert.ok(gap, "emits a DETAIL_GAP keyed by the repair archive path");
    assert.equal(gap?.stream, "messages");
    assert.equal(gap?.reason, "temporary_unavailable");
    assert.equal(gap?.retryable, true);
    assert.equal(gap?.status, "pending");
    assert.equal((gap?.detail_locator as { kind?: unknown } | undefined)?.kind, "slack.scoped_archive_resume");
    assert.ok(
      !result.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
      "does not emit DETAIL_GAP_RECOVERED for a new-repair attempt that never succeeded"
    );

    // Preserves the pre-existing invariant: even though the fake binary left
    // real partial __uploads/ bytes on disk before failing (modeling a
    // genuine mid-dump crash), SLACK_RECLAIM_UPLOADS=1 must NOT reclaim them
    // — there is no durable-commit receipt for a failed attempt. This is the
    // exact gate `repair.outcome.kind === "resumed"` enforces (not the old
    // `repair.archivePath` truthiness check, which is now always true
    // regardless of success/failure and would incorrectly reclaim here).
    assert.ok(
      existsSync(join(repairArchiveDir, "__uploads")),
      "the partial __uploads/ residue from the failed attempt is untouched, not silently reclaimed"
    );
  } finally {
    if (priorBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = priorBin;
    }
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a later successful NEW-repair attempt emits DETAIL_GAP_RECOVERED for a previously-failed repair archive path", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-reconcile-repair-recovered-"));
  try {
    const workspace = "reconcile-repair-recovered-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const repairArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(baseArchiveDir, { recursive: true });
    // This time the repair archive already exists with the channel data —
    // modeling "the new-repair attempt now succeeds" (PDPP_SLACK_SKIP_SLACKDUMP=1
    // reads the existing, valid archive rather than failing to find one).
    await mkdir(repairArchiveDir, { recursive: true });

    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }
    const repairDb = new DatabaseSync(join(repairArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(repairDb);
      insertChannel(repairDb, "C0MISSING", "missing");
      insertMessage(repairDb, "C0MISSING", "1714032850.123456", "recovered via new-repair attempt");
    } finally {
      repairDb.close();
    }

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
        // A prior run's failed new-repair attempt left this durable gap
        // pending, keyed to the repair archive path exactly as this fix's
        // repairMissingScopedArchive path now emits it.
        detail_gaps: [
          {
            gap_id: "gap_prior_new_repair_attempt",
            record_key: repairArchiveDir,
            status: "pending",
            stream: "messages",
          },
        ],
      },
    });

    const recovered = result.messages.find(
      (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> => m.type === "DETAIL_GAP_RECOVERED"
    );
    assert.ok(recovered, "emits DETAIL_GAP_RECOVERED once the new-repair attempt succeeds");
    assert.equal(recovered?.gap_id, "gap_prior_new_repair_attempt");
    assert.equal(recovered?.record_key, repairArchiveDir);
    assert.equal(recovered?.stream, "messages");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
