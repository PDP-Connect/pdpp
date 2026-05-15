import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
