import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
