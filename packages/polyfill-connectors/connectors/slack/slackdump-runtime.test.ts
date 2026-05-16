import assert from "node:assert/strict";
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
