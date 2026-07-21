import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import {
  formatSlackdumpMissingError,
  runSlackdump,
  SLACK_RETRYABLE_FAILURE_RE,
  slackdumpProgressChanged,
} from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const SLACK_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "slack", "index.ts");
const SLACK_MANIFEST = join(PACKAGE_ROOT, "manifests", "slack.json");

function createSlackArchiveSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE CHANNEL (
      ID TEXT NOT NULL,
      NAME TEXT,
      DATA TEXT,
      CHUNK_ID INTEGER NOT NULL
    );
    CREATE TABLE MESSAGE (
      CHANNEL_ID TEXT NOT NULL,
      TS TEXT NOT NULL,
      THREAD_TS TEXT,
      IS_PARENT INTEGER,
      TXT TEXT,
      NUM_FILES INTEGER,
      DATA BLOB,
      CHUNK_ID INTEGER NOT NULL
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
    `
    INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    channelId,
    ts,
    null,
    null,
    text,
    null,
    new TextEncoder().encode(JSON.stringify({ text, user: "U0123456789" })),
    1
  );
}

function scopedArchiveDigest(channels: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(channels)].sort()))
    .digest("hex")
    .slice(0, 12);
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

test("formatSlackdumpMissingError: describes path contract and Docker remediation", () => {
  const message = formatSlackdumpMissingError("/opt/bin/slackdump");

  assert.match(message, /slackdump binary not found: \/opt\/bin\/slackdump/);
  assert.match(message, /SLACKDUMP_BIN/);
  assert.match(message, /PATH/);
  assert.match(message, /stock reference image does not bundle/);
});

test("runSlackdump: maps ENOENT to actionable missing-binary guidance", async () => {
  const prior = process.env.SLACKDUMP_BIN;
  process.env.SLACKDUMP_BIN = "/definitely/missing/slackdump";

  try {
    await assert.rejects(
      runSlackdump(["--help"], { env: process.env, timeoutMs: 1000 }),
      /slackdump binary not found: \/definitely\/missing\/slackdump/
    );
  } finally {
    if (prior === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = prior;
    }
  }
});

test("slack retry classification treats slackdump exit 6 as resumable", () => {
  assert.equal(SLACK_RETRYABLE_FAILURE_RE.test("slackdump failed: slackdump_exit_6: conversations.history 500"), true);
  assert.equal(SLACK_RETRYABLE_FAILURE_RE.test("parser error: unexpected token in archive"), false);
});

test("runSlackdump: emits safe archive-growth progress while child is running", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-progress-"));
  const fakeSlackdump = join(tmpDir, "fake-slackdump.mjs");
  const sqlitePath = join(tmpDir, "slackdump.sqlite");
  const progressEvents: Array<{ extra: unknown; message: string }> = [];
  const priorBin = process.env.SLACKDUMP_BIN;

  await writeFile(
    fakeSlackdump,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

setTimeout(() => {
  writeFileSync(process.env.TEST_SQLITE_PATH + "-wal", "archive grew");
}, 25);
setTimeout(() => process.exit(0), 100);
`,
    "utf8"
  );
  await chmod(fakeSlackdump, 0o755);
  process.env.SLACKDUMP_BIN = fakeSlackdump;

  try {
    await runSlackdump(["resume"], {
      env: { ...process.env, TEST_SQLITE_PATH: sqlitePath },
      progress: (message, extra = {}) => {
        progressEvents.push({ extra, message });
        return Promise.resolve();
      },
      progressIntervalMs: 10,
      progressLabel: "resume",
      sqlitePath,
      timeoutMs: 1000,
    });
  } finally {
    if (priorBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = priorBin;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }

  assert.ok(progressEvents.length >= 1, "expected archive-growth progress");
  assert.match(progressEvents[0]?.message ?? "", /Slack slackdump resume progress:/);
  assert.match(progressEvents[0]?.message ?? "", /archive_bytes=/);
  assert.equal((progressEvents[0]?.extra as { stream?: unknown } | undefined)?.stream, "messages");
});

test("runSlackdump: detects progress from row counts even when a WAL checkpoint keeps archive bytes flat", async () => {
  // SQLite WAL mode can checkpoint (fold the WAL back into the main file and
  // reuse its allocation) on every commit, so combined main+WAL+SHM byte size
  // can stay unchanged across real, committed writes. An archiveBytes-only
  // progress check would silently miss this and let the scheduler's
  // progress-driven watchdog time out a healthy long-running dump. The fake
  // slackdump here performs REAL WAL-mode commits with wal_autocheckpoint=1
  // (matching the condition that keeps file size flat) so this test would
  // fail if slackdumpProgressChanged only compared archiveBytes.
  const tmpDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-wal-checkpoint-"));
  const fakeSlackdump = join(tmpDir, "fake-slackdump.mjs");
  const sqlitePath = join(tmpDir, "slackdump.sqlite");
  const progressEvents: Array<{ extra: unknown; message: string }> = [];
  const priorBin = process.env.SLACKDUMP_BIN;

  await writeFile(
    fakeSlackdump,
    `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.TEST_SQLITE_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA wal_autocheckpoint=1");
db.exec(\`
  CREATE TABLE CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
  CREATE TABLE MESSAGE (CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER, TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL);
\`);
db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run("C1", "general", "{}", 1);

let n = 0;
const insert = setInterval(() => {
  n += 1;
  db.prepare("INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("C1", String(n), null, null, "msg " + n, null, Buffer.from("{}"), 1);
  if (n >= 3) {
    clearInterval(insert);
    db.close();
    process.exit(0);
  }
}, 15);
`,
    "utf8"
  );
  await chmod(fakeSlackdump, 0o755);
  process.env.SLACKDUMP_BIN = fakeSlackdump;

  try {
    await runSlackdump(["resume"], {
      env: { ...process.env, TEST_SQLITE_PATH: sqlitePath },
      progress: (message, extra = {}) => {
        progressEvents.push({ extra, message });
        return Promise.resolve();
      },
      progressIntervalMs: 10,
      progressLabel: "resume",
      sqlitePath,
      timeoutMs: 1000,
    });
  } finally {
    if (priorBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = priorBin;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }

  const messageCounts = progressEvents.map((event) => (event.extra as { count?: unknown } | undefined)?.count);
  assert.ok(
    messageCounts.some((count) => typeof count === "number" && count >= 2),
    `expected progress to observe message count advancing past the first commit; got counts=${JSON.stringify(messageCounts)}`
  );
});

test("slackdumpProgressChanged does not treat a failed read (counts falling to null) as progress", () => {
  // readSlackdumpProgressSnapshot falls back to null for channels/maxChunkId/
  // messages when the archive is locked or mid-write (its try/catch). A
  // naive !== comparison sees `null !== 5` as "changed" and would report a
  // read FAILURE as real progress — with nothing on disk having actually
  // happened. Only a transition between two successfully-read, differing
  // non-null values counts.
  const previous = { archiveBytes: 1000, channels: 2, maxChunkId: 3, messages: 5 };
  const failedRead = { archiveBytes: 1000, channels: null, maxChunkId: null, messages: null };
  assert.equal(
    slackdumpProgressChanged(previous, failedRead),
    false,
    "a transient failed read must not be reported as progress"
  );
});

test("slackdumpProgressChanged still detects a real count advance even when archiveBytes is flat", () => {
  const previous = { archiveBytes: 1000, channels: 2, maxChunkId: 3, messages: 5 };
  const advanced = { archiveBytes: 1000, channels: 2, maxChunkId: 3, messages: 6 };
  assert.equal(
    slackdumpProgressChanged(previous, advanced),
    true,
    "a genuine successful-read count advance must still be reported as progress"
  );
});

test("slack manifest declares no unsupported-in-mode streams (all four gap streams now collect directly)", async () => {
  const manifest = JSON.parse(await readFile(SLACK_MANIFEST, "utf8")) as {
    streams?: Array<{
      availability?: { state?: string; mode?: string };
      coverage_policy?: string;
      name?: string;
      required?: boolean;
    }>;
  };
  const unsupported = (manifest.streams || []).filter((stream) => stream.availability?.state === "unsupported_in_mode");
  assert.deepEqual(
    unsupported,
    [],
    "stars/user_groups/reminders/dm_read_states are collected via direct Slack Web API calls; the manifest must not declare them unsupported_in_mode"
  );
  for (const streamName of ["stars", "user_groups", "reminders", "dm_read_states"]) {
    const stream = (manifest.streams || []).find((s) => s.name === streamName);
    assert.ok(stream, `expected manifest to declare stream ${streamName}`);
    assert.equal(
      stream?.coverage_policy,
      undefined,
      `${streamName} should default to coverage_policy "collect" (no explicit deferred/unsupported/unavailable)`
    );
    // Regression guard for the 7cc177eec class of bug: these four streams
    // are network-callable (direct Slack Web API calls, not slackdump-
    // archive-derived) and therefore independently failable. `required`
    // must be explicitly `false` — not merely absent — so a future edit
    // that touches this stream object can't silently reintroduce the
    // implicit-required-true default and make one supplementary stream's
    // failure fail the whole connector run again.
    assert.equal(
      stream?.required,
      false,
      `${streamName} is collected via an independently-failable direct API call and MUST declare "required": false explicitly ` +
        "(required defaults to true when absent — see coverage-policy-manifest-honesty.test.ts)"
    );
  }
});

test("slack connector reports DONE.records_emitted from runtime-counted RECORDs", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-counter-"));
  try {
    const workspace = "counter-test";
    const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      db.exec(`
        CREATE TABLE MESSAGE (
          CHANNEL_ID TEXT NOT NULL,
          TS TEXT NOT NULL,
          THREAD_TS TEXT,
          IS_PARENT INTEGER,
          TXT TEXT,
          NUM_FILES INTEGER,
          DATA BLOB,
          CHUNK_ID INTEGER NOT NULL
        );
      `);
      db.prepare(
        `
        INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        "C0123456789",
        "1714032849.123456",
        null,
        null,
        "hello from slack",
        null,
        new TextEncoder().encode(JSON.stringify({ text: "hello from slack", user: "U0123456789" })),
        1
      );
    } finally {
      db.close();
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
      },
    });

    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
    );
    const done = result.messages.findLast(
      (message): message is Extract<EmittedMessage, { type: "DONE" }> => message.type === "DONE"
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.stream, "messages");
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.records_emitted, records.length);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector counts channel-scoped message RECORDs in DONE.records_emitted", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-counter-"));
  try {
    const workspace = "scoped-counter-test";
    const archiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C02SCOPED"])
    );
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      db.exec(`
        CREATE TABLE MESSAGE (
          CHANNEL_ID TEXT NOT NULL,
          TS TEXT NOT NULL,
          THREAD_TS TEXT,
          IS_PARENT INTEGER,
          TXT TEXT,
          NUM_FILES INTEGER,
          DATA BLOB,
          CHUNK_ID INTEGER NOT NULL
        );
      `);
      const insert = db.prepare(`
        INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "C02SCOPED",
        "1714032849.123456",
        null,
        null,
        "included",
        null,
        new TextEncoder().encode(JSON.stringify({ text: "included", user: "U0123456789" })),
        1
      );
      insert.run(
        "C02OTHER",
        "1714032850.123456",
        null,
        null,
        "excluded",
        null,
        new TextEncoder().encode(JSON.stringify({ text: "excluded", user: "U0123456789" })),
        1
      );
    } finally {
      db.close();
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
        scope: { streams: [{ name: "messages", resources: ["C02SCOPED"] }] },
      },
    });

    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
    );
    const done = result.messages.findLast(
      (message): message is Extract<EmittedMessage, { type: "DONE" }> => message.type === "DONE"
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.data.channel_id, "C02SCOPED");
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.records_emitted, records.length);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector emits a bounded source-partition diagnostic when a prior channel is missing", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-missing-channel-"));
  try {
    const workspace = "missing-channel-test";
    const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(db);
      insertChannel(db, "C_PRESENT", "present");
      insertMessage(db, "C_PRESENT", "1714032849.123456", "still present");
    } finally {
      db.close();
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
            channel_last_ts: {
              C_MISSING: "1714032800.000000",
              C_PRESENT: "1714032800.000000",
            },
            observed_channel_ids: ["C_MISSING", "C_PRESENT"],
          },
        },
      },
    });

    const gap = result.messages.find(
      (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
        message.type === "SKIP_RESULT" && message.reason === "source_partition_missing"
    );
    assert.ok(gap, "expected source_partition_missing SKIP_RESULT");
    assert.equal(gap.stream, "messages");
    assert.deepEqual((gap.diagnostics as { missing_channel_ids?: string[] }).missing_channel_ids, ["C_MISSING"]);
    assert.deepEqual(gap.recovery_hint, { action: "retry_by_runtime", retryable: true });
    assert.match(gap.message, /coverage is partial/);

    const cursor = messagesState(result);
    assert.deepEqual(cursor.observed_channel_ids, ["C_MISSING", "C_PRESENT"]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector heals a missing prior channel from an existing scoped archive", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-heal-"));
  try {
    const workspace = "scoped-heal-test";
    const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const scopedDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest(["C0MISSING"])
    );
    await mkdir(archiveDir, { recursive: true });
    await mkdir(scopedDir, { recursive: true });

    const baseDb = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessage(baseDb, "C0PRESENT", "1714032849.123456", "still present");
    } finally {
      baseDb.close();
    }

    const scopedDb = new DatabaseSync(join(scopedDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(scopedDb);
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
            channel_last_ts: {
              C0MISSING: "1714032800.000000",
              C0PRESENT: "1714032800.000000",
            },
            observed_channel_ids: ["C0MISSING", "C0PRESENT"],
          },
        },
      },
    });

    assert.equal(
      result.messages.some(
        (message) => message.type === "SKIP_RESULT" && message.reason === "source_partition_missing"
      ),
      false
    );
    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
        message.type === "RECORD" && message.stream === "messages"
    );
    assert.deepEqual(records.map((record) => record.data.channel_id).sort(), ["C0MISSING", "C0PRESENT"]);
    const cursor = messagesState(result);
    assert.deepEqual(cursor.observed_channel_ids, ["C0MISSING", "C0PRESENT"]);
    assert.deepEqual(cursor.channel_last_ts, {
      C0MISSING: "1714032850.123456",
      C0PRESENT: "1714032849.123456",
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector does not emit a missing-partition diagnostic when prior channels remain present", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-clean-channel-"));
  try {
    const workspace = "clean-channel-test";
    const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(db);
      insertChannel(db, "C_PRESENT", "present");
      insertMessage(db, "C_PRESENT", "1714032849.123456", "still present");
    } finally {
      db.close();
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
            channel_last_ts: { C_PRESENT: "1714032800.000000" },
            observed_channel_ids: ["C_PRESENT"],
          },
        },
      },
    });

    assert.equal(
      result.messages.some(
        (message) => message.type === "SKIP_RESULT" && message.reason === "source_partition_missing"
      ),
      false
    );
    assert.deepEqual(messagesState(result).observed_channel_ids, ["C_PRESENT"]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector uses per-channel message cursors with legacy global fallback", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-channel-cursor-"));
  try {
    const workspace = "channel-cursor-test";
    const archiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(db);
      insertChannel(db, "C1", "one");
      insertChannel(db, "C2", "two");
      insertMessage(db, "C1", "1714031500.000000", "new for C1 but older than global");
      insertMessage(db, "C1", "1714030900.000000", "old for C1");
      insertMessage(db, "C2", "1714031600.000000", "older than global fallback");
      insertMessage(db, "C2", "1714032500.000000", "new by global fallback");
    } finally {
      db.close();
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
            last_ts: "1714032000.000000",
            channel_last_ts: { C1: "1714031000.000000" },
            observed_channel_ids: ["C1", "C2"],
          },
        },
      },
    });

    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
    );
    assert.deepEqual(records.map((record) => record.key).sort(), ["C1:1714031500.000000", "C2:1714032500.000000"]);

    const cursor = messagesState(result);
    assert.equal(cursor.last_ts, "1714032500.000000");
    assert.deepEqual(cursor.channel_last_ts, {
      C1: "1714031500.000000",
      C2: "1714032500.000000",
    });
    assert.deepEqual(cursor.observed_channel_ids, ["C1", "C2"]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector uses an isolated scoped archive for targeted channel backfill", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-archive-"));
  try {
    const workspace = "scoped-archive-test";
    const scopedChannelId = "C02SCOPE123";
    const mainArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const scopedArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest([scopedChannelId])
    );
    await mkdir(mainArchiveDir, { recursive: true });
    await mkdir(scopedArchiveDir, { recursive: true });

    const mainDb = new DatabaseSync(join(mainArchiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(mainDb);
      insertChannel(mainDb, "C_MAIN", "main");
      insertMessage(mainDb, "C_MAIN", "1714033000.000000", "main archive row");
    } finally {
      mainDb.close();
    }

    const scopedDb = new DatabaseSync(join(scopedArchiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(scopedDb);
      insertChannel(scopedDb, scopedChannelId, "scope");
      insertMessage(scopedDb, scopedChannelId, "1714033500.000000", "scoped archive row");
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
        scope: { streams: [{ name: "messages", resources: [scopedChannelId] }] },
        state: {
          messages: {
            archive_dir: mainArchiveDir,
            last_ts: "1714030000.000000",
          },
        },
      },
    });

    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
    );
    assert.deepEqual(
      records.map((record) => record.key),
      [`${scopedChannelId}:1714033500.000000`]
    );
    assert.equal(messagesState(result).archive_dir, mainArchiveDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("slack connector emits scoped archive rows even when they are older than the channel cursor", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-hole-"));
  try {
    const workspace = "scoped-hole-test";
    const scopedChannelId = "C02HOLE123";
    const mainArchiveDir = join(homeDir, ".pdpp", "slackdump", workspace, "archive");
    const scopedArchiveDir = join(
      homeDir,
      ".pdpp",
      "slackdump",
      workspace,
      "archive-scoped",
      scopedArchiveDigest([scopedChannelId])
    );
    await mkdir(mainArchiveDir, { recursive: true });
    await mkdir(scopedArchiveDir, { recursive: true });

    const scopedDb = new DatabaseSync(join(scopedArchiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(scopedDb);
      insertChannel(scopedDb, scopedChannelId, "scope");
      insertMessage(scopedDb, scopedChannelId, "1714031000.000000", "historical missing row");
      insertMessage(scopedDb, scopedChannelId, "1714033500.000000", "new scoped row");
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
        scope: { streams: [{ name: "messages", resources: [scopedChannelId] }] },
        state: {
          messages: {
            archive_dir: mainArchiveDir,
            last_ts: "1714033000.000000",
            channel_last_ts: { [scopedChannelId]: "1714033000.000000" },
            observed_channel_ids: [scopedChannelId],
          },
        },
      },
    });

    const records = result.messages.filter(
      (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
    );
    assert.deepEqual(records.map((record) => record.key).sort(), [
      `${scopedChannelId}:1714031000.000000`,
      `${scopedChannelId}:1714033500.000000`,
    ]);
    const cursor = messagesState(result);
    assert.equal(cursor.last_ts, "1714033500.000000");
    assert.deepEqual(cursor.channel_last_ts, { [scopedChannelId]: "1714033500.000000" });
    assert.deepEqual(cursor.observed_channel_ids, [scopedChannelId]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
