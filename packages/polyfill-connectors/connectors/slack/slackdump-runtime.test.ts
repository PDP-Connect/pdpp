// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveConnectorArtifactDir } from "../../src/connector-artifact-root.ts";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import {
  extractSlackCredentials,
  formatSlackdumpMissingError,
  normalizeSlackCookie,
  normalizeSlackToken,
  normalizeSlackWorkspace,
  readSlackdumpProgressSnapshot,
  runSlackdump,
  SLACK_RETRYABLE_FAILURE_RE,
  slackdumpProgressChanged,
} from "./index.ts";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the connector will look for `<workspace>`'s archive, given an artifact
 * root the test owns. Derived from the SAME resolver the connector uses, so
 * these tests pin the seam rather than re-encoding the on-disk layout: if the
 * root moves again, the seed follows automatically.
 *
 * Tests drive it with `PDPP_CONNECTOR_ARTIFACT_ROOT` (rule 1) rather than
 * `HOME`, because the connector no longer derives the archive path from the
 * home directory — that was the container-replacement data-loss bug.
 */
function seedArchiveRoot(artifactRoot: string, workspace: string): string {
  return resolveConnectorArtifactDir("slack", [workspace], {
    PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
  }).root;
}

const PACKAGE_ROOT = resolve(__dirname, "../..");
const SLACK_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "slack", "index.ts");
const SLACK_MANIFEST = join(PACKAGE_ROOT, "manifests", "slack.json");
const VALID_SLACK_TOKEN = "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("Slack credential normalization preserves URL-encoded d-cookie bytes", () => {
  const encodedCookie = "xoxd-session-a%2Bb%2Fc%3D%3D";
  const rawCookie = "xoxd-session-a+b/c==";
  const opaqueToken = "xoxc-enterprise/session.v2+opaque==";
  const opaqueCookie = "xoxd-enterprise/session.v2+opaque==?&!";

  assert.equal(normalizeSlackCookie(`  d=${encodedCookie}  `), encodedCookie);
  assert.equal(normalizeSlackCookie(rawCookie), rawCookie);
  assert.equal(normalizeSlackToken(`  ${VALID_SLACK_TOKEN}  `), VALID_SLACK_TOKEN);
  assert.equal(normalizeSlackToken(`  ${opaqueToken}  `), opaqueToken);
  assert.equal(normalizeSlackCookie(opaqueCookie), opaqueCookie);
  assert.equal(normalizeSlackWorkspace("  MyTeam  "), "myteam");

  assert.deepEqual(
    extractSlackCredentials({
      SLACK_WORKSPACE: "  myteam  ",
      SLACK_TOKEN: `  ${opaqueToken}  `,
      SLACK_COOKIE: `d=${opaqueCookie}`,
    }),
    { workspace: "myteam", token: opaqueToken, cookie: opaqueCookie }
  );
});

test("Slack credential normalization rejects empty, control, malformed, and oversized values", () => {
  assert.throws(() => normalizeSlackToken(" "), /slack_token_invalid/);
  assert.throws(() => normalizeSlackToken("xoxp-not-a-client-token"), /slack_token_invalid/);
  assert.throws(() => normalizeSlackToken("xoxc-valid\u0000opaque"), /slack_token_invalid/);
  assert.throws(() => normalizeSlackToken(`xoxc-${"a".repeat(4092)}`), /slack_token_invalid/);
  assert.throws(() => normalizeSlackCookie("d= "), /slack_cookie_invalid/);
  assert.throws(() => normalizeSlackCookie("xoxd-session-%2"), /slack_cookie_invalid/);
  assert.throws(() => normalizeSlackCookie("xoxd-valid\u0001opaque"), /slack_cookie_invalid/);
  assert.throws(() => normalizeSlackCookie(`xoxd-${"a".repeat(4092)}`), /slack_cookie_invalid/);
  assert.throws(() => normalizeSlackWorkspace("../outside"), /slack_workspace_invalid/);
  assert.throws(() => extractSlackCredentials({ SLACK_WORKSPACE: "myteam", SLACK_TOKEN: "", SLACK_COOKIE: "" }), {
    message: "slack_credentials_missing",
  });
});

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

test("runSlackdump: redacts session credentials from child failure output", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-redaction-"));
  const fakeSlackdump = join(tmpDir, "fake-slackdump.mjs");
  const token = VALID_SLACK_TOKEN;
  const cookie = "xoxd-session-secret%2Bvalue";
  const priorBin = process.env.SLACKDUMP_BIN;

  await writeFile(
    fakeSlackdump,
    `#!/usr/bin/env node
process.stderr.write("token=" + process.env.SLACK_TOKEN + " cookie=" + process.env.SLACK_COOKIE);
process.stdout.write("stdout-token=" + process.env.SLACK_TOKEN);
process.exit(7);
`,
    "utf8"
  );
  await chmod(fakeSlackdump, 0o755);
  process.env.SLACKDUMP_BIN = fakeSlackdump;

  try {
    await assert.rejects(
      runSlackdump(["workspace", "new"], {
        env: { ...process.env, SLACK_TOKEN: token, SLACK_COOKIE: cookie },
        timeoutMs: 1000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /slackdump_exit_7/);
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(cookie));
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      }
    );
  } finally {
    if (priorBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = priorBin;
    }
    await rm(tmpDir, { recursive: true, force: true });
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

test("runSlackdump: detects progress from mtime even when a WAL checkpoint keeps archive bytes flat", async () => {
  // SQLite WAL mode can checkpoint (fold the WAL back into the main file and
  // reuse its allocation) on every commit, so combined main+WAL+SHM byte size
  // can stay unchanged across real, committed writes. An archiveBytes-only
  // progress check would silently miss this and let the scheduler's
  // progress-driven watchdog time out a healthy long-running dump. The fake
  // slackdump here performs REAL WAL-mode commits with wal_autocheckpoint=1
  // (matching the condition that keeps file size flat) so this test would
  // fail if slackdumpProgressChanged only compared archiveBytes. Detection
  // must come from stat-ing the file (mtime), NOT from opening the SQLite
  // archive ourselves — see readSlackdumpProgressSnapshot's comment for why.
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

  // At least one commit must be observed AFTER the first (i.e. more than one
  // progress event), proving mtime advanced across a checkpoint that left
  // combined byte size unchanged.
  assert.ok(
    progressEvents.length >= 2,
    `expected more than one progress event across multiple checkpointed commits; got ${progressEvents.length}`
  );
});

test("slackdumpProgressChanged does not treat a missing archive (null) as progress", () => {
  const previous = { archiveBytes: 1000, archiveMtimeMs: 111 };
  const missing: { archiveBytes: number; archiveMtimeMs: number } | null = null;
  assert.equal(
    slackdumpProgressChanged(previous, missing),
    false,
    "a transient missing-archive read must not be reported as progress"
  );
});

test("slackdumpProgressChanged detects an mtime advance even when archiveBytes is flat", () => {
  const previous = { archiveBytes: 1000, archiveMtimeMs: 111 };
  const advanced = { archiveBytes: 1000, archiveMtimeMs: 222 };
  assert.equal(
    slackdumpProgressChanged(previous, advanced),
    true,
    "a genuine mtime advance must still be reported as progress even when byte size is flat"
  );
});

// THE concurrency oracle for the observer-induced lock. Confirms the fix is
// real: a writer that holds a multi-row transaction against the archive
// (slackdump does real batched inserts, not one-row-per-open) must never see
// SQLITE_BUSY from our own polling reader. Before the fix, readSlackdumpProgressSnapshot
// opened a read-only SQLite connection on every poll tick; that reader's
// SHARED lock could collide with the writer's COMMIT and fail the writer's
// OWN transaction — confirmed directly via a standalone repro (batched
// writer + concurrent read-only poller against a rollback-journal-mode
// archive: SQLITE_BUSY on COMMIT in roughly half of repeated trials). This
// test pins the after-state: polling `readSlackdumpProgressSnapshot` at the
// same real cadence a live run would use, concurrently with a genuine
// multi-row committed transaction, must never perturb the writer.
test("readSlackdumpProgressSnapshot polling never causes a concurrent multi-row writer transaction to fail", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-lock-oracle-"));
  const sqlitePath = join(tmpDir, "slackdump.sqlite");
  try {
    const db = new DatabaseSync(sqlitePath);
    try {
      createSlackArchiveSchema(db);
    } finally {
      db.close();
    }

    const writerScript = join(tmpDir, "writer.mjs");
    await writeFile(
      writerScript,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new DatabaseSync(process.argv[2]);
for (let batch = 0; batch < 150; batch++) {
  db.exec("BEGIN");
  for (let i = 0; i < 50; i++) {
    const n = batch * 50 + i;
    db.prepare(
      "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?,?,?,?,?,?,?,?)"
    ).run("C0PROGRESS", "17140330" + String(n).padStart(6, "0") + ".000000", null, null, "chunk " + n, null, null, n + 1);
  }
  db.exec("COMMIT");
  await sleep(3);
}
db.close();
console.log("writer-ok");
`,
      "utf8"
    );
    await chmod(writerScript, 0o755);

    // Poll at the same 5ms cadence used to reliably reproduce the pre-fix
    // regression in isolation, for the ~450ms+ window the writer's 150
    // batched commits (with a short gap between each) take to run.
    let pollCount = 0;
    const pollTimer = setInterval(() => {
      pollCount += 1;
      readSlackdumpProgressSnapshot(sqlitePath);
    }, 5);

    try {
      const { stdout } = await execFileAsync(process.execPath, [writerScript, sqlitePath], { timeout: 30_000 });
      assert.match(stdout, /writer-ok/);
    } finally {
      clearInterval(pollTimer);
    }
    assert.ok(pollCount > 20, `expected many concurrent polls during the writer run; got ${pollCount}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

test("slack manifest explains the xoxc token and d-cookie fields with the official manual", async () => {
  const manifest = JSON.parse(await readFile(SLACK_MANIFEST, "utf8")) as {
    setup?: {
      credential_capture?: {
        description?: string;
        fields?: Array<{ help_text?: string; help_url?: string; label?: string; name?: string }>;
      };
    };
  };
  const setup = manifest.setup?.credential_capture;
  const token = setup?.fields?.find((field) => field.name === "slack_token");
  const cookie = setup?.fields?.find((field) => field.name === "slack_cookie");
  assert.match(setup?.description ?? "", /not an OAuth app token/);
  assert.match(token?.label ?? "", /web-client session token/);
  assert.match(token?.help_text ?? "", /localConfig_v2/);
  assert.match(cookie?.label ?? "", /d cookie value/);
  assert.match(cookie?.help_text ?? "", /cookie named exactly d/);
  assert.match(cookie?.help_text ?? "", /not d=/);
  assert.match(cookie?.help_text ?? "", /%2F.*%2B/);
  assert.equal(token?.help_url, cookie?.help_url);
  assert.match(
    token?.help_url ?? "",
    /github\.com\/rusq\/slackdump\/blob\/5ecece6b7fa63f6e1a71e049900b9ccc61f6b1e7\/doc\/login-manual\.md/
  );
  assert.doesNotMatch(token?.help_url ?? "", /wiki\/How-to-get-your-Slack-credentials/);
});

test("slack connector reports DONE.records_emitted from runtime-counted RECORDs", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-counter-"));
  try {
    const workspace = "counter-test";
    const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector counts channel-scoped message RECORDs in DONE.records_emitted", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-counter-"));
  try {
    const workspace = "scoped-counter-test";
    const archiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector emits a bounded source-partition diagnostic when a prior channel is missing", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-missing-channel-"));
  try {
    const workspace = "missing-channel-test";
    const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector heals a missing prior channel from an existing scoped archive", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-heal-"));
  try {
    const workspace = "scoped-heal-test";
    const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
    assert.deepEqual(
      records
        .map((record) => String(record.data.channel_id))
        .sort((a, b) => {
          if (a < b) {
            return -1;
          }
          return a > b ? 1 : 0;
        }),
      ["C0MISSING", "C0PRESENT"]
    );
    const cursor = messagesState(result);
    assert.deepEqual(cursor.observed_channel_ids, ["C0MISSING", "C0PRESENT"]);
    assert.deepEqual(cursor.channel_last_ts, {
      C0MISSING: "1714032850.123456",
      C0PRESENT: "1714032849.123456",
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector does not emit a missing-partition diagnostic when prior channels remain present", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-clean-channel-"));
  try {
    const workspace = "clean-channel-test";
    const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector uses per-channel message cursors with legacy global fallback", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-channel-cursor-"));
  try {
    const workspace = "channel-cursor-test";
    const archiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
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
    assert.deepEqual(
      records
        .map((record) => String(record.key))
        .sort((a, b) => {
          if (a < b) {
            return -1;
          }
          return a > b ? 1 : 0;
        }),
      ["C1:1714031500.000000", "C2:1714032500.000000"]
    );

    const cursor = messagesState(result);
    assert.equal(cursor.last_ts, "1714032500.000000");
    assert.deepEqual(cursor.channel_last_ts, {
      C1: "1714031500.000000",
      C2: "1714032500.000000",
    });
    assert.deepEqual(cursor.observed_channel_ids, ["C1", "C2"]);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector uses an isolated scoped archive for targeted channel backfill", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-archive-"));
  try {
    const workspace = "scoped-archive-test";
    const scopedChannelId = "C02SCOPE123";
    const mainArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("slack connector emits scoped archive rows even when they are older than the channel cursor", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-hole-"));
  try {
    const workspace = "scoped-hole-test";
    const scopedChannelId = "C02HOLE123";
    const mainArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedArchiveDir = join(
      seedArchiveRoot(artifactRoot, workspace),
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
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    assert.deepEqual(
      records
        .map((record) => String(record.key))
        .sort((a, b) => {
          if (a < b) {
            return -1;
          }
          return a > b ? 1 : 0;
        }),
      [`${scopedChannelId}:1714031000.000000`, `${scopedChannelId}:1714033500.000000`]
    );
    const cursor = messagesState(result);
    assert.equal(cursor.last_ts, "1714033500.000000");
    assert.deepEqual(cursor.channel_last_ts, { [scopedChannelId]: "1714033500.000000" });
    assert.deepEqual(cursor.observed_channel_ids, [scopedChannelId]);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

// The container-replacement regression, pinned at the connector boundary.
//
// The archive used to be computed from `homedir()`. The documented deployment
// mounts only `/var/lib/pdpp`, so `$HOME` was on the container's writable layer
// and every `docker rm` + `docker run` destroyed the accumulated archive —
// nine consecutive real runs died on slackdump_timeout re-downloading it.
//
// This test recreates that split: the archive is seeded next to PDPP_DB_PATH
// (the deployment's persistent volume) while HOME points at a DIFFERENT,
// empty directory standing in for the discarded writable layer. The connector
// must read the archive on the durable volume and ignore HOME entirely. Before
// the fix it looked under HOME, found nothing, and failed.
test("slack archive resolves next to PDPP_DB_PATH, not HOME (survives container replacement)", async () => {
  const durableVolume = await mkdtemp(join(tmpdir(), "pdpp-slack-durable-"));
  const discardedHome = await mkdtemp(join(tmpdir(), "pdpp-slack-discarded-home-"));
  try {
    const workspace = "recreate-test";
    // Stand in for `-v pdpp_data:/var/lib/pdpp` + the baked
    // PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite that Core ships.
    const dbPath = join(durableVolume, "pdpp.sqlite");
    const archiveDir = join(
      resolveConnectorArtifactDir("slack", [workspace], { PDPP_DB_PATH: dbPath }).root,
      "archive"
    );
    await mkdir(archiveDir, { recursive: true });
    const db = new DatabaseSync(join(archiveDir, "slackdump.sqlite"));
    try {
      createSlackArchiveSchema(db);
      insertChannel(db, "C0DURABLE", "durable");
      insertMessage(db, "C0DURABLE", "1714032849.123456", "survived the recreate");
    } finally {
      db.close();
    }

    // The archive must live on the durable volume, never under HOME.
    assert.ok(archiveDir.startsWith(durableVolume), `expected archive under the durable volume, got ${archiveDir}`);
    assert.ok(!archiveDir.startsWith(discardedHome));

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: discardedHome,
        PDPP_DB_PATH: dbPath,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: VALID_SLACK_TOKEN,
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
    assert.equal(done?.status, "succeeded");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.stream, "messages");

    // The run log must state the durable root it chose, and must NOT claim the
    // local-development fallback while running against a deployment path.
    const progress = result.messages
      .filter((message): message is Extract<EmittedMessage, { type: "PROGRESS" }> => message.type === "PROGRESS")
      .map((message) => message.message)
      .join("\n");
    assert.match(progress, /Durable artifact root/);
    assert.doesNotMatch(progress, /LOCAL-DEVELOPMENT FALLBACK/);

    // HOME stayed untouched — nothing durable was written to the layer that
    // container replacement discards.
    assert.equal(existsSync(join(discardedHome, ".pdpp")), false);
  } finally {
    await rm(durableVolume, { recursive: true, force: true });
    await rm(discardedHome, { recursive: true, force: true });
  }
});

// ─── Stall budget vs total-runtime cap ────────────────────────────────
//
// The UAT terminal failure this pins: `SLACKDUMP_TIMEOUT_MS` was enforced as a
// TOTAL wall-clock cap. With the deployment's 90-minute value, a first sync of
// a multi-year workspace was killed mid-download while steadily making
// progress — 13k-17k records emitted and 80k+ messages banked in the archive,
// yet every stream left uncommitted and zero successful runs. The budget must
// bound SILENCE, not useful work.

/**
 * Write a fake slackdump that appends real rows to the archive on a cadence,
 * then sleeps. `advances` controls how many progress steps it makes before
 * going quiet, which is what separates a healthy long run from a true stall.
 */
async function writeProgressingSlackdump(
  path: string,
  { advances, stepMs, thenIdleMs }: { advances: number; stepMs: number; thenIdleMs: number }
): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const archive = process.env.FAKE_ARCHIVE_PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < ${advances}; i++) {
  await sleep(${stepMs});
  const db = new DatabaseSync(archive);
  try {
    db.prepare(
      "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?,?,?,?,?,?,?,?)"
    ).run("C0PROGRESS", "17140330" + String(i).padStart(2, "0") + ".000000", null, null, "chunk " + i, null, null, i + 1);
  } finally {
    db.close();
  }
}
await sleep(${thenIdleMs});
process.exit(0);
`,
    "utf8"
  );
  await chmod(path, 0o755);
}

async function withFakeSlackdump<T>(fn: (paths: { archive: string; bin: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-stall-"));
  const prior = process.env.SLACKDUMP_BIN;
  try {
    const archive = join(dir, "slackdump.sqlite");
    const db = new DatabaseSync(archive);
    try {
      createSlackArchiveSchema(db);
    } finally {
      db.close();
    }
    const bin = join(dir, "fake-slackdump.mjs");
    process.env.SLACKDUMP_BIN = bin;
    return await fn({ archive, bin });
  } finally {
    if (prior === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = prior;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

// THE regression. Total runtime (~1.8s) far exceeds the 600ms budget, but the
// child never goes quiet for more than ~200ms. Under the old total-runtime cap
// this rejected with slackdump_timeout; under a stall budget it must succeed.
test("runSlackdump: a steadily-progressing dump outlives its budget (stall, not total runtime)", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 9, stepMs: 200, thenIdleMs: 0 });

    await runSlackdump(["archive"], {
      env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
      progressIntervalMs: 50,
      sqlitePath: archive,
      timeoutMs: 600,
    });
  });
});

// The other half of the contract: real silence must still be terminal, or the
// budget would be worthless. Same budget, but the child stops advancing.
test("runSlackdump: a genuinely stalled dump still times out", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 1, stepMs: 50, thenIdleMs: 30_000 });

    await assert.rejects(
      runSlackdump(["archive"], {
        env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
        progressIntervalMs: 50,
        sqlitePath: archive,
        timeoutMs: 700,
      }),
      /slackdump_timeout/
    );
  });
});

// Progress must rearm the budget even when nothing is reporting it: stall
// detection reads the archive directly and must not depend on a `progress`
// callback being supplied.
test("runSlackdump: progress rearms the budget with no progress callback attached", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 8, stepMs: 200, thenIdleMs: 0 });

    await runSlackdump(["archive"], {
      env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
      progressIntervalMs: 50,
      sqlitePath: archive,
      timeoutMs: 600,
    });
  });
});

// With no observable archive there is no progress signal, so the budget can
// only mean total runtime. Pins that degradation explicitly.
test("runSlackdump: without an observable archive the budget stays a total-runtime deadline", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 20, stepMs: 100, thenIdleMs: 0 });

    await assert.rejects(
      runSlackdump(["archive"], {
        env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
        timeoutMs: 500,
      }),
      /slackdump_timeout/
    );
  });
});

// An absolute ceiling stays available for operators who want one, and is
// reported as a distinct reason so it is never confused with a stall.
test("runSlackdump: SLACKDUMP_MAX_RUNTIME_MS caps even a progressing dump, with a distinct reason", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 30, stepMs: 100, thenIdleMs: 0 });

    await assert.rejects(
      runSlackdump(["archive"], {
        env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
        maxRuntimeMs: 900,
        progressIntervalMs: 50,
        sqlitePath: archive,
        timeoutMs: 60_000,
      }),
      /slackdump_max_runtime/
    );
  });
});

// Both timeout shapes must classify retryable: the durable archive means a
// retry resumes rather than restarting the multi-hour dump from zero.
test("both slackdump timeout shapes are retryable failures", () => {
  assert.equal(SLACK_RETRYABLE_FAILURE_RE.test("slackdump failed: slackdump_timeout"), true);
  assert.equal(SLACK_RETRYABLE_FAILURE_RE.test("slackdump failed: slackdump_max_runtime"), true);
});

// A child that exits without ever making progress must settle on its OWN exit
// event, promptly — never wait out the (now 24h-default) silence budget. This
// is what keeps a genuinely broken invocation fast to fail even though the
// budget bounds silence rather than runtime.
test("runSlackdump: a child that exits with no progress settles immediately, not after the budget", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeProgressingSlackdump(bin, { advances: 0, stepMs: 0, thenIdleMs: 0 });

    const startedAt = Date.now();
    await runSlackdump(["archive"], {
      env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
      progressIntervalMs: 50,
      sqlitePath: archive,
      // A budget far larger than the test could ever wait for: the only way
      // this returns is the child's own exit path.
      timeoutMs: 10 * 60 * 1000,
    });

    assert.ok(Date.now() - startedAt < 10_000, "expected exit-driven settle, not a budget wait");
  });
});

// Same contract on the failure side, and the reason must stay the exit code —
// a no-progress failure is not reported as a stall.
test("runSlackdump: a failing child reports its exit code, never a stall, and settles promptly", async () => {
  await withFakeSlackdump(async ({ archive, bin }) => {
    await writeFile(bin, "#!/usr/bin/env node\nprocess.exit(4);\n", "utf8");
    await chmod(bin, 0o755);

    const startedAt = Date.now();
    await assert.rejects(
      runSlackdump(["archive"], {
        env: { ...process.env, FAKE_ARCHIVE_PATH: archive },
        progressIntervalMs: 50,
        sqlitePath: archive,
        timeoutMs: 10 * 60 * 1000,
      }),
      /slackdump_exit_4/
    );
    assert.ok(Date.now() - startedAt < 10_000, "expected exit-driven settle, not a budget wait");
  });
});
