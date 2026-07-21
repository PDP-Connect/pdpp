// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

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

test("claude_code emits coverage diagnostics for a missing source home before failing", async () => {
  // A host whose requested content sources are absent must still produce the
  // durable coverage signal: every known store classified `missing`, emitted
  // BEFORE the source-presence assert throws. Without this the run fails with
  // zero coverage evidence and the connection-health rollup is stuck at
  // `coverage_unknown` forever (the local run path writes no spine run).
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-missing-coverage-"));
  const result = await runConnectorProcess({
    env: { CLAUDE_CODE_HOME: claudeHome },
    start: {
      scope: {
        streams: [{ name: "sessions" }, { name: "skills" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  // The run still fails honestly on the missing content sources.
  assert.notEqual(result.exitCode, 0);
  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");

  // …but coverage diagnostics were already emitted, classifying the absent
  // declared stores as `missing` rather than omitting the stream entirely.
  const coverage = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
      msg.type === "RECORD" && msg.stream === "coverage_diagnostics"
  );
  assert(coverage.length > 0, "expected coverage diagnostics to be emitted before the failure");
  assert(
    coverage.some((record) => record.data.store === "projects" && record.data.status === "missing"),
    "expected the absent projects store to be reported as missing"
  );
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
  const coverageState = result.messages.find(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
      msg.type === "STATE" && msg.stream === "coverage_diagnostics"
  );
  assert.equal(typeof (coverageState?.cursor as { fetched_at?: unknown } | undefined)?.fetched_at, "string");
  const stores = (coverageState?.cursor as { stores?: unknown } | undefined)?.stores;
  assert(Array.isArray(stores), "successful collection must emit the committed coverage snapshot");
  assert.equal(stores.length, 11);
  assert(!JSON.stringify(coverageState).includes("secret-token"));
  assert(!JSON.stringify(coverageState).includes("reason"));
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

test("claude_code markdown-backed streams skip unchanged files from state", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-markdown-state-"));
  const projectsDir = join(claudeHome, "projects");
  await mkdir(join(claudeHome, "skills", "demo-skill"), { recursive: true });
  await mkdir(join(claudeHome, "commands"), { recursive: true });
  await mkdir(join(projectsDir, "-tmp-demo", "memory"), { recursive: true });
  await writeFile(join(claudeHome, "skills", "demo-skill", "SKILL.md"), "---\nname: Demo Skill\n---\nbody");
  await writeFile(join(claudeHome, "commands", "demo.md"), "---\nname: Demo Command\n---\nbody");
  await writeFile(join(projectsDir, "-tmp-demo", "memory", "note.md"), "---\ntitle: Demo Note\n---\nbody");

  const start = {
    scope: { streams: [{ name: "skills" }, { name: "slash_commands" }, { name: "memory_notes" }] },
    type: "START",
  };
  const env = { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir };
  const first = await runConnectorProcess({ env, start });
  assert.equal(first.exitCode, 0);
  const firstRecords = first.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert.deepEqual(firstRecords.map((record) => record.stream).sort(), ["memory_notes", "skills", "slash_commands"]);

  const state = Object.fromEntries(
    first.messages
      .filter((msg): msg is Extract<EmittedMessage, { type: "STATE" }> => msg.type === "STATE")
      .map((msg) => [msg.stream, msg.cursor])
  );
  assert.equal(Object.keys((state.skills as { file_mtimes?: Record<string, number> }).file_mtimes ?? {}).length, 1);
  assert.equal(
    Object.keys((state.slash_commands as { file_mtimes?: Record<string, number> }).file_mtimes ?? {}).length,
    1
  );
  assert.equal(
    Object.keys((state.memory_notes as { file_mtimes?: Record<string, number> }).file_mtimes ?? {}).length,
    1
  );

  const second = await runConnectorProcess({ env, start: { ...start, state } });
  assert.equal(second.exitCode, 0);
  const secondRecords = second.messages.filter((msg) => msg.type === "RECORD");
  assert.equal(secondRecords.length, 0, "unchanged markdown-backed streams should not re-emit records");
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
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: input.env,
    start: input.start as {
      scope: {
        streams: Array<{ name: string; resources?: string[]; time_range?: { since?: string; until?: string } }>;
      };
      state?: Record<string, unknown>;
      type: "START";
    },
  });
  return { exitCode: result.code, messages: result.messages, stderr: result.stderr };
}
