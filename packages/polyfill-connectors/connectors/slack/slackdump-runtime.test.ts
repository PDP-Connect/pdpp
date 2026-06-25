import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { formatSlackdumpMissingError, runSlackdump, UNAVAILABLE_STREAMS } from "./index.ts";

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

test("slack manifest unsupported-in-mode streams match connector safety-net skips", async () => {
  const manifest = JSON.parse(await readFile(SLACK_MANIFEST, "utf8")) as {
    streams?: Array<{ name?: string; availability?: { state?: string; mode?: string } }>;
  };
  const manifestUnavailable = (manifest.streams || [])
    .filter((stream) => stream.availability?.state === "unsupported_in_mode")
    .map((stream) => `${stream.name}:${stream.availability?.mode}`)
    .sort();
  const connectorUnavailable = UNAVAILABLE_STREAMS.map((stream) => `${stream.name}:slackdump_archive`).sort();

  assert.deepEqual(
    manifestUnavailable,
    connectorUnavailable,
    "Slack manifest unsupported-in-mode declarations must stay aligned with emitted SKIP_RESULT safety-net streams"
  );
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
        scope: { streams: [{ name: "messages" }, { name: "stars" }] },
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
    assert.ok(
      result.messages.some((message) => message.type === "SKIP_RESULT" && message.stream === "stars"),
      "known slackdump gaps should remain honest SKIP_RESULT events"
    );
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
    assert.match(gap.message, /coverage is partial/);

    const cursor = messagesState(result);
    assert.deepEqual(cursor.observed_channel_ids, ["C_MISSING", "C_PRESENT"]);
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
