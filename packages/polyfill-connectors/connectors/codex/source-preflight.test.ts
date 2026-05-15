import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";

test("codex connector fails instead of succeeding when requested local sources are missing", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-missing-"));
  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "messages" }, { name: "rules" }] },
      type: "START",
    },
  });

  assert.notEqual(result.exitCode, 0);
  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.match(done?.error?.message ?? "", /requested Codex local source path\(s\) are missing or unreadable/);
  assert.match(done?.error?.message ?? "", /CODEX_SESSIONS_DIR=/);
  assert.match(done?.error?.message ?? "", /CODEX_RULES_DIR=/);
});

test("codex inventory streams emit safe metadata and exclude auth payloads", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-inventory-"));
  await mkdir(join(codexHome, "cache"), { recursive: true });
  await writeFile(join(codexHome, "history.jsonl"), '{"prompt":"hello"}\n');
  await writeFile(join(codexHome, "session_index.jsonl"), '{"id":"session"}\n');
  await writeFile(join(codexHome, "cache", "response.json"), "cache payload");
  await writeFile(join(codexHome, "auth.json"), '{"api_key":"secret-token"}');

  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: {
        streams: [
          { name: "history" },
          { name: "session_index" },
          { name: "cache_inventory" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert(records.some((record) => record.stream === "history" && record.data.relative_path === "history.jsonl"));
  assert(
    records.some((record) => record.stream === "session_index" && record.data.relative_path === "session_index.jsonl")
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

async function runConnectorProcess(input: {
  env: NodeJS.ProcessEnv;
  start: unknown;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[]; stderr: string }> {
  const child = spawn("tsx", ["connectors/codex/index.ts"], {
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
