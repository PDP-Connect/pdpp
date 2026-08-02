// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import {
  formatSlackdumpMissingError,
  loadSlackdumpProviderAuth,
  parseSlackdumpProviderAuth,
  resolveSlackApiCredentials,
  runSlackdump,
  runSlackdumpIdentityHelper,
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

const VALID_SLACKDUMP_TOKEN = `xoxc-1-2-3-${"a".repeat(64)}`;
const VALID_SLACKDUMP_COOKIE = `xoxd-${"a".repeat(32)}`;

function archiveIdentity(url: string): { teamId: string; url: string } {
  return { teamId: "T_SYNTHETIC", url };
}

test("Slackdump provider bridge accepts only bounded official xoxc/d credentials", async () => {
  assert.deepEqual(
    parseSlackdumpProviderAuth(
      JSON.stringify({
        Token: VALID_SLACKDUMP_TOKEN,
        Cookie: [
          { Name: "d-s", Value: "synthetic-d-s", Domain: ".slack.com", Path: "/" },
          { Name: "d", Value: VALID_SLACKDUMP_COOKIE, Domain: ".slack.com", Path: "/" },
        ],
      })
    ),
    { token: VALID_SLACKDUMP_TOKEN, cookie: VALID_SLACKDUMP_COOKIE }
  );
  assert.equal(parseSlackdumpProviderAuth("encrypted-provider-by-slackdump"), null);
  assert.equal(
    parseSlackdumpProviderAuth(
      JSON.stringify({ Token: "xoxp-personal-token", Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] })
    ),
    null
  );
  assert.equal(
    parseSlackdumpProviderAuth(
      JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: "d-invalid" }] })
    ),
    null
  );
  assert.equal(parseSlackdumpProviderAuth(JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN })), null);
  assert.equal(parseSlackdumpProviderAuth("{"), null);
  assert.equal(parseSlackdumpProviderAuth(`${"x".repeat(16 * 1024)}\n`), null);

  const cacheDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-provider-"));
  try {
    await writeFile(join(cacheDir, "workspace.txt"), "default\n", "utf8");
    await writeFile(
      join(cacheDir, "provider.bin"),
      JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
      "utf8"
    );
    const env = { CACHE_DIR: cacheDir };
    const proof = await loadSlackdumpProviderAuth(env);
    assert.ok(proof);
    assert.equal(proof.providerName, "default");
    assert.equal(proof.token, VALID_SLACKDUMP_TOKEN);
    assert.equal(proof.cookie, VALID_SLACKDUMP_COOKIE);
    const explicit = { workspace: "synthetic-workspace", token: "xoxc-injected-token", cookie: "injected-d" };
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://synthetic-workspace.slack.com/")),
      { workspace: "synthetic-workspace", token: VALID_SLACKDUMP_TOKEN, cookie: VALID_SLACKDUMP_COOKIE }
    );
    assert.deepEqual(
      await resolveSlackApiCredentials(
        { workspace: "default", token: "xoxc-default-supplied", cookie: "d-default-supplied" },
        proof,
        archiveIdentity("https://synthetic-workspace.slack.com/")
      ),
      { workspace: "default", token: "xoxc-default-supplied", cookie: "d-default-supplied" },
      "default is a provider alias, never a requested connection identity"
    );
    for (const url of [
      "http://synthetic-workspace.slack.com/",
      "https://synthetic-workspace.slack.com/path",
      "https://synthetic-workspace.slack.com/?query=1",
      "https://synthetic-workspace.slack.com/#fragment",
      "https://synthetic-workspace.slack.com:444/",
    ]) {
      assert.deepEqual(
        await resolveSlackApiCredentials(explicit, proof, archiveIdentity(url)),
        explicit,
        `archive identity must reject ${url}`
      );
    }
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://other.slack.com/")),
      explicit,
      "the default provider alias cannot authorize another workspace"
    );
    await writeFile(join(cacheDir, "workspace.txt"), "other\n", "utf8");
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://synthetic-workspace.slack.com/")),
      explicit,
      "marker drift after capture must fail closed"
    );
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, { teamId: "", url: "https://synthetic-workspace.slack.com/" }),
      explicit,
      "an archive without stable team identity must retain supplied credentials"
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("Slackdump auth proof fails closed for wrong archive identity, skip mode, and provider mutation", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-proof-"));
  const explicit = { workspace: "requested", token: "xoxc-supplied", cookie: "d-supplied" };
  try {
    await writeFile(join(cacheDir, "workspace.txt"), "other\n", "utf8");
    await writeFile(
      join(cacheDir, "other.bin"),
      JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
      "utf8"
    );
    const wrongProviderProof = await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir });
    assert.ok(wrongProviderProof);
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, wrongProviderProof, archiveIdentity("https://other.slack.com/")),
      explicit
    );
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, wrongProviderProof, archiveIdentity("https://requested.slack.com/")),
      explicit
    );
    await writeFile(join(cacheDir, "workspace.txt"), "requested\n", "utf8");
    await writeFile(
      join(cacheDir, "requested.bin"),
      JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
      "utf8"
    );
    const proof = await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir });
    assert.ok(proof);
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://requested.slack.com/")),
      {
        workspace: "requested",
        token: VALID_SLACKDUMP_TOKEN,
        cookie: VALID_SLACKDUMP_COOKIE,
      }
    );

    await writeFile(
      join(cacheDir, "requested.bin"),
      JSON.stringify({
        Token: `xoxc-1-2-3-${"b".repeat(64)}`,
        Cookie: [{ Name: "d", Value: `xoxd-${"b".repeat(32)}` }],
      }),
      "utf8"
    );
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://requested.slack.com/")),
      explicit,
      "a provider changed after archive success must not replace supplied credentials"
    );
    await rm(join(cacheDir, "requested.bin"));
    await symlink(join(cacheDir, "missing-provider.bin"), join(cacheDir, "requested.bin"));
    assert.deepEqual(
      await resolveSlackApiCredentials(explicit, proof, archiveIdentity("https://requested.slack.com/")),
      explicit,
      "provider replacement with a symlink must fail closed"
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("Slackdump provider bridge rejects invalid markers, oversized/truncated files, symlinks, and nonregular files", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-boundary-"));
  const provider = JSON.stringify({
    Token: VALID_SLACKDUMP_TOKEN,
    Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }],
  });
  try {
    await writeFile(join(cacheDir, "workspace.txt"), "../other\n", "utf8");
    await writeFile(join(cacheDir, "provider.bin"), provider, "utf8");
    assert.equal(await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir }), null);

    await writeFile(join(cacheDir, "workspace.txt"), "default\n", "utf8");
    await writeFile(join(cacheDir, "provider.bin"), "{", "utf8");
    assert.equal(await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir }), null);
    await writeFile(join(cacheDir, "provider.bin"), "x".repeat(16 * 1024 + 1), "utf8");
    assert.equal(await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir }), null);
    await rm(join(cacheDir, "provider.bin"));
    await mkdir(join(cacheDir, "provider.bin"));
    assert.equal(await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir }), null);
    await rm(join(cacheDir, "provider.bin"), { recursive: true });
    await symlink(join(cacheDir, "missing-provider.bin"), join(cacheDir, "provider.bin"));
    assert.equal(await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir }), null);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("Slackdump identity companion has bounded malformed and timeout behavior", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-identity-protocol-"));
  const cacheDir = join(homeDir, "cache");
  const helper = join(homeDir, "identity-helper.mjs");
  const priorHelper = process.env.SLACKDUMP_IDENTITY_BIN;
  const priorMode = process.env.HELPER_MODE;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, "workspace.txt"), "protocol-test\n", "utf8");
  await writeFile(
    join(cacheDir, "protocol-test.bin"),
    JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
    "utf8"
  );
  await writeFile(
    helper,
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("pdpp-slackdump-identity/3.1.13 github.com/rusq/slackdump/v3@v3.1.13\\n");
  process.exit(0);
}
if (process.env.HELPER_MODE === "timeout") {
  setInterval(() => {}, 1000);
} else if (process.env.HELPER_MODE === "malformed") {
  process.stdout.write("not-json\\n");
  process.exit(0);
}
`,
    "utf8"
  );
  await chmod(helper, 0o755);
  const proof = await loadSlackdumpProviderAuth({ CACHE_DIR: cacheDir });
  assert.ok(proof);
  process.env.SLACKDUMP_IDENTITY_BIN = helper;
  try {
    process.env.HELPER_MODE = "malformed";
    await assert.rejects(
      runSlackdumpIdentityHelper(proof, { ...process.env, CACHE_DIR: cacheDir }, "protocol-test"),
      /slackdump_identity_invalid/
    );
    process.env.HELPER_MODE = "timeout";
    await assert.rejects(
      runSlackdumpIdentityHelper(proof, { ...process.env, CACHE_DIR: cacheDir }, "protocol-test"),
      /slackdump_identity_helper_timeout/
    );
  } finally {
    if (priorHelper === undefined) {
      delete process.env.SLACKDUMP_IDENTITY_BIN;
    } else {
      process.env.SLACKDUMP_IDENTITY_BIN = priorHelper;
    }
    if (priorMode === undefined) {
      delete process.env.HELPER_MODE;
    } else {
      process.env.HELPER_MODE = priorMode;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("full collect pins the proved Slackdump provider before opening the archive", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pdpp-slackdump-proof-collect-"));
  const cacheDir = join(homeDir, "cache");
  const fakeSlackdump = join(homeDir, "fake-slackdump.mjs");
  const fakeIdentityHelper = join(homeDir, "fake-slackdump-identity.mjs");
  const argsPath = join(homeDir, "args.json");
  const snapshotPathFile = join(homeDir, "snapshot-path.txt");
  const helperObservationPath = join(homeDir, "identity-helper-observation.json");
  const workspace = "proof-collect";
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, "workspace.txt"), "default\n", "utf8");
  await writeFile(
    join(cacheDir, "provider.bin"),
    JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
    "utf8"
  );
  await writeFile(
    fakeSlackdump,
    `#!/usr/bin/env node
import { mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const args = process.argv.slice(2);
writeFileSync(process.env.SNAPSHOT_PATH_FILE, process.env.CACHE_DIR);
writeFileSync(process.env.SNAPSHOT_MODE_FILE, JSON.stringify({
  directory: statSync(process.env.CACHE_DIR).mode & 0o777,
  provider: statSync(process.env.CACHE_DIR + "/provider.bin").mode & 0o777,
}));
if (args[0] === "workspace" && args[1] === "list") {
  process.stdout.write("default =>\\n");
  process.exit(0);
}
writeFileSync(process.env.ARGS_PATH, JSON.stringify(args));
if (process.env.FAIL_ARCHIVE === "1" && (args[0] === "archive" || args[0] === "resume")) process.exit(9);
const outputIndex = args.indexOf("-o");
const output = outputIndex === -1 ? process.env.ARCHIVE_PATH : args[outputIndex + 1];
if (outputIndex !== -1) {
  mkdirSync(output, { recursive: true });
  const db = new DatabaseSync(output + "/slackdump.sqlite");
  db.exec("CREATE TABLE MESSAGE (CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER, TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL); CREATE TABLE WORKSPACE (TEAM_ID TEXT, URL TEXT, CHUNK_ID INTEGER);");
  db.prepare("INSERT INTO WORKSPACE (TEAM_ID, URL, CHUNK_ID) VALUES (?, ?, ?)").run(process.env.ARCHIVE_TEAM_ID, process.env.ARCHIVE_URL, 1);
  db.close();
}
if (process.env.MUTATE_SNAPSHOT === "1") {
  unlinkSync(process.env.CACHE_DIR + "/provider.bin");
  symlinkSync("/dev/null", process.env.CACHE_DIR + "/provider.bin");
}
`,
    "utf8"
  );
  await chmod(fakeSlackdump, 0o755);
  await writeFile(
    fakeIdentityHelper,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  process.stdout.write("pdpp-slackdump-identity/3.1.13 github.com/rusq/slackdump/v3@v3.1.13\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(process.env.HELPER_OBSERVATION_PATH, JSON.stringify({
    argv_has_secret: process.argv.some((value) => value.includes("xoxc-") || value.includes("xoxd-")),
    env_has_secret: Boolean(process.env.SLACK_TOKEN || process.env.SLACK_COOKIE),
    stdin_is_json: (() => { try { const parsed = JSON.parse(input); return typeof parsed.token === "string" && parsed.token.startsWith("xoxc-") && typeof parsed.cookie === "string" && parsed.cookie.startsWith("xoxd-"); } catch { return false; } })(),
  }));
  process.stdout.write(JSON.stringify({ team_id: process.env.ARCHIVE_TEAM_ID, url: process.env.ARCHIVE_URL }) + "\\n");
});

`,
    "utf8"
  );
  await chmod(fakeIdentityHelper, 0o755);

  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 5), ["archive", "-y", "-no-encryption", "-workspace", "default"]);
    assert.deepEqual(JSON.parse(await readFile(helperObservationPath, "utf8")), {
      argv_has_secret: false,
      env_has_secret: false,
      stdin_is_json: true,
    });
    const snapshotPath = (await readFile(snapshotPathFile, "utf8")).trim();
    await assert.rejects(readFile(join(snapshotPath, "provider.bin")), /ENOENT/);
    assert.deepEqual(JSON.parse(await readFile(join(homeDir, "snapshot-mode.json"), "utf8")), {
      directory: 0o700,
      provider: 0o600,
    });
    assert.equal(result.messages.findLast((message) => message.type === "DONE")?.status, "succeeded");
    const firstRunOutput = JSON.stringify(result.messages);
    assert.equal(firstRunOutput.includes(VALID_SLACKDUMP_TOKEN), false, "provider token must never be logged");
    assert.equal(firstRunOutput.includes(VALID_SLACKDUMP_COOKIE), false, "provider cookie must never be logged");

    const argsBeforeSkip = await readFile(argsPath, "utf8");
    const skipResult = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    assert.equal(skipResult.messages.findLast((message) => message.type === "DONE")?.status, "succeeded");
    assert.deepEqual(JSON.parse(await readFile(helperObservationPath, "utf8")), {
      argv_has_secret: false,
      env_has_secret: false,
      stdin_is_json: true,
    });
    assert.equal(await readFile(argsPath, "utf8"), argsBeforeSkip, "skip mode must not invoke Slackdump");

    const mutatedResult = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        MUTATE_SNAPSHOT: "1",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    assert.ok(
      mutatedResult.messages.some(
        (message) => message.type === "PROGRESS" && message.message.includes("auth snapshot changed during archive")
      ),
      "snapshot replacement during resume must retain supplied credentials"
    );
    const mutatedRunOutput = JSON.stringify(mutatedResult.messages);
    assert.equal(
      mutatedRunOutput.includes(VALID_SLACKDUMP_TOKEN),
      false,
      "mutated provider token must never be logged"
    );
    assert.equal(
      mutatedRunOutput.includes(VALID_SLACKDUMP_COOKIE),
      false,
      "mutated provider cookie must never be logged"
    );
    const mutatedSnapshotPath = (await readFile(snapshotPathFile, "utf8")).trim();
    await assert.rejects(readFile(join(mutatedSnapshotPath, "provider.bin")), /ENOENT/);

    const argsBeforeDrift = await readFile(argsPath, "utf8");
    const driftResult = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        PDPP_SLACK_TEST_MUTATE_MARKER: "after_snapshot",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    const driftDone = driftResult.messages.findLast((message) => message.type === "DONE");
    assert.equal(driftDone?.status, "failed");
    assert.match(driftDone?.error?.message ?? "", /slackdump_auth_source_drift/);
    assert.equal(await readFile(argsPath, "utf8"), argsBeforeDrift, "marker drift must invoke zero archive children");
    await writeFile(join(cacheDir, "workspace.txt"), "default\n", "utf8");

    const argsBeforeSnapshotFailure = await readFile(argsPath, "utf8");
    const snapshotFailureResult = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        PDPP_SLACK_TEST_SNAPSHOT_WRITE_FAILURE: "1",
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    const snapshotFailureDone = snapshotFailureResult.messages.findLast((message) => message.type === "DONE");
    assert.match(snapshotFailureDone?.error?.message ?? "", /slackdump_auth_snapshot_write_failed/);
    assert.equal(
      await readFile(argsPath, "utf8"),
      argsBeforeSnapshotFailure,
      "snapshot write failure must invoke zero archive children"
    );

    const failedChildResult = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        HOME: homeDir,
        CACHE_DIR: cacheDir,
        FAIL_ARCHIVE: "1",
        PDPP_SLACK_TEST_SNAPSHOT_RM_FAILURE: "1",
        SLACKDUMP_BIN: fakeSlackdump,
        SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
        ARGS_PATH: argsPath,
        HELPER_OBSERVATION_PATH: helperObservationPath,
        SNAPSHOT_PATH_FILE: snapshotPathFile,
        SNAPSHOT_MODE_FILE: join(homeDir, "snapshot-mode.json"),
        ARCHIVE_PATH: join(homeDir, ".pdpp", "slackdump", workspace, "archive"),
        ARCHIVE_URL: `https://${workspace}.slack.com`,
        ARCHIVE_TEAM_ID: "T_PROOF_COLLECT",
        SLACK_COOKIE: "d=supplied",
        SLACK_TOKEN: "xoxc-supplied",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      },
    });
    const failedChildDone = failedChildResult.messages.findLast((message) => message.type === "DONE");
    assert.match(failedChildDone?.error?.message ?? "", /slackdump_exit_9/);
    const failedSnapshotPath = (await readFile(snapshotPathFile, "utf8")).trim();
    assert.equal(
      await readFile(join(failedSnapshotPath, "provider.bin"), "utf8"),
      "",
      "cleanup must scrub provider bytes before removal failure"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
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

test("named and default identity mismatches fail before any archive child or target write", async () => {
  const cases = [
    { marker: "provider-b", providerFile: "provider-b.bin", helperUrl: "https://requested.slack.com/", label: "named" },
    { marker: "default", providerFile: "provider.bin", helperUrl: "https://provider-b.slack.com/", label: "default" },
  ] as const;
  for (const scenario of cases) {
    const homeDir = await mkdtemp(join(tmpdir(), `pdpp-slackdump-${scenario.label}-mismatch-`));
    const cacheDir = join(homeDir, "cache");
    const fakeSlackdump = join(homeDir, "fake-slackdump.mjs");
    const fakeIdentityHelper = join(homeDir, "fake-slackdump-identity.mjs");
    const callPath = join(homeDir, "calls.json");
    const workspace = "requested";
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "workspace.txt"), `${scenario.marker}\n`, "utf8");
    await writeFile(
      join(cacheDir, scenario.providerFile),
      JSON.stringify({ Token: VALID_SLACKDUMP_TOKEN, Cookie: [{ Name: "d", Value: VALID_SLACKDUMP_COOKIE }] }),
      "utf8"
    );
    await writeFile(
      fakeSlackdump,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CALL_PATH, JSON.stringify(args));
if (args[0] === "workspace" && args[1] === "list") process.stdout.write("${scenario.marker} =>\\n");
`,
      "utf8"
    );
    await writeFile(
      fakeIdentityHelper,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") { process.stdout.write("pdpp-slackdump-identity/3.1.13 github.com/rusq/slackdump/v3@v3.1.13\\n"); process.exit(0); }
else { process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ team_id: "T_PROVIDER_B", url: "${scenario.helperUrl}" }) + "\\n")); }
`,
      "utf8"
    );
    await chmod(fakeSlackdump, 0o755);
    await chmod(fakeIdentityHelper, 0o755);
    try {
      const result = await runConnectorProtocolSubprocess({
        allowFailedDone: true,
        cwd: PACKAGE_ROOT,
        entrypoint: SLACK_ENTRYPOINT,
        env: {
          HOME: homeDir,
          CACHE_DIR: cacheDir,
          CALL_PATH: callPath,
          SLACKDUMP_BIN: fakeSlackdump,
          SLACKDUMP_IDENTITY_BIN: fakeIdentityHelper,
          SLACK_COOKIE: "d=supplied",
          SLACK_TOKEN: "xoxc-supplied",
          SLACK_WORKSPACE: workspace,
        },
        start: { type: "START", scope: { streams: [{ name: "messages" }] } },
      });
      const done = result.messages.findLast((message) => message.type === "DONE");
      assert.equal(done?.status, "failed");
      assert.match(done?.error?.message ?? "", /slackdump_identity_/);
      const childArgs = JSON.parse(await readFile(callPath, "utf8")) as string[];
      assert.equal(
        childArgs.some((arg) => arg === "archive" || arg === "resume"),
        false
      );
      await assert.rejects(readFile(join(homeDir, ".pdpp", "slackdump", workspace, "archive")), /ENOENT/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }
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

test("slack manifest declares an OPTIONAL browser binding for the gap streams' browser transport", async () => {
  // stars/user_groups/reminders/dm_read_states need a real Chromium page
  // (see slack-api.ts module header + index.ts acquireSlackApiBrowserTransport
  // for the full root cause: browser capability) — but the connector's core
  // value (messages/channels/files/etc., all slackdump-archive-derived)
  // must stay fully headless. `required: false` is the load-bearing part:
  // `true` would make the RUNTIME refuse to spawn the whole connector on any
  // runtime that doesn't advertise a browser binding (validateRequiredRuntimeBindings
  // in reference-implementation/runtime/index.ts), even though only these
  // four optional streams ever touch it.
  const manifest = JSON.parse(await readFile(SLACK_MANIFEST, "utf8")) as {
    runtime_requirements?: { bindings?: Record<string, { required?: boolean }> };
  };
  const browserBinding = manifest.runtime_requirements?.bindings?.browser;
  assert.ok(browserBinding, "expected runtime_requirements.bindings.browser to be declared");
  assert.equal(
    browserBinding?.required,
    false,
    "the browser binding MUST be optional — required:true would block the whole connector's spawn on a " +
      "runtime with no browser binding, for the sake of four non-core streams"
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
    await rm(homeDir, { recursive: true, force: true });
  }
});
