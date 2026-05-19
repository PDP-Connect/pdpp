import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";

test("claude_code connector fails instead of succeeding when requested local sources are missing", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-missing-"));
  const result = await runConnectorProcess({
    env: { CLAUDE_CODE_HOME: claudeHome },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "skills" }, { name: "slash_commands" }] },
      type: "START",
    },
  });

  assert.notEqual(result.exitCode, 0);
  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.match(done?.error?.message ?? "", /requested Claude Code local source path\(s\) are missing or unreadable/);
  assert.match(done?.error?.message ?? "", /CLAUDE_CODE_PROJECTS_DIR=/);
  assert.match(done?.error?.message ?? "", /skills directory=/);
  assert.match(done?.error?.message ?? "", /commands directory=/);
});

test("claude_code inventory streams emit safe metadata and exclude auth payloads", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-inventory-"));
  await mkdir(join(claudeHome, "file-history"), { recursive: true });
  await mkdir(join(claudeHome, "cache"), { recursive: true });
  await writeFile(join(claudeHome, "file-history", "snapshot.json"), '{"path":"/tmp/example"}');
  await writeFile(join(claudeHome, "cache", "raw-cache.json"), "cache payload");
  await writeFile(join(claudeHome, "auth.json"), '{"token":"secret-token"}');

  const result = await runConnectorProcess({
    env: { CLAUDE_CODE_HOME: claudeHome },
    start: {
      scope: { streams: [{ name: "file_history" }, { name: "cache_inventory" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert(records.some((record) => record.stream === "file_history" && record.data.relative_path === "file-history"));
  assert(
    records.some(
      (record) => record.stream === "file_history" && record.data.relative_path === "file-history/snapshot.json"
    )
  );
  assert(records.some((record) => record.stream === "cache_inventory" && record.data.relative_path === "cache"));
  assert(!records.some((record) => JSON.stringify(record).includes("secret-token")));
  assert(
    !records.some((record) => record.stream !== "coverage_diagnostics" && record.data.relative_path === "auth.json")
  );
  assert(
    records.some(
      (record) =>
        record.stream === "coverage_diagnostics" && record.data.store === "auth" && record.data.status === "excluded"
    )
  );
});

test("claude_code context_mode is diagnostics-only, not a requestable stream", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-private-"));
  await mkdir(join(claudeHome, "context-mode"), { recursive: true });
  await writeFile(join(claudeHome, "context-mode", "local.json"), '{"private":"do-not-emit"}');

  const result = await runConnectorProcess({
    env: { CLAUDE_CODE_HOME: claudeHome },
    start: {
      scope: { streams: [{ name: "context_mode" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert(!records.some((record) => record.stream === "context_mode"));
  assert(!records.some((record) => JSON.stringify(record).includes("do-not-emit")));
  assert(
    records.some(
      (record) =>
        record.stream === "coverage_diagnostics" &&
        record.data.store === "context_mode" &&
        record.data.stream === null &&
        record.data.status === "inventory_only"
    )
  );
  assert(
    !result.messages.some(
      (msg) => msg.type === "STATE" && (msg as Extract<EmittedMessage, { type: "STATE" }>).stream === "context_mode"
    )
  );
});

test("claude_code manifest does not expose context_mode as a consentable stream", async () => {
  const manifestPath = join(import.meta.dirname, "../../manifests/claude_code.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { streams: Array<{ name: string }> };

  assert(!manifest.streams.some((stream) => stream.name === "context_mode"));
});

async function runConnectorProcess(input: {
  env: NodeJS.ProcessEnv;
  start: unknown;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[]; stderr: string }> {
  const child = spawn("tsx", ["connectors/claude_code/index.ts"], {
    cwd: join(import.meta.dirname, "../.."),
    env: { ...process.env, ...input.env },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(input.start)}\n`);
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  const messages = Buffer.concat(stdout)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EmittedMessage);
  return { exitCode, messages, stderr: Buffer.concat(stderr).toString("utf8") };
}
