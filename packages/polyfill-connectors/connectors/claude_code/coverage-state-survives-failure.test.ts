// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Regression coverage for the "advertised stream honesty" follow-up (shared
 * architecture with connectors/codex/coverage-state-survives-failure.test.ts):
 * the inventory pass that classifies static stores (file_history, cache,
 * backups, config) runs before assertRequestedClaudeSources and the JSONL
 * project scan, and has nothing to do with either. Before this fix, the
 * `coverage_diagnostics` STATE cursor for a full run was written only once,
 * at the very end of `collect()`, after every requested project stream
 * finished. A run that failed partway through — e.g. a genuinely missing
 * CLAUDE_CODE_PROJECTS_DIR — never reached that write, so the durable
 * checkpoint kept whatever per-store classification an earlier run had
 * committed, even though a fresh `coverage_diagnostics` RECORD for every
 * store was already emitted and durably ingested moments earlier in the
 * SAME run.
 */

function states(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> => msg.type === "STATE" && msg.stream === stream
  );
}

function fileHistoryStatus(state: Extract<EmittedMessage, { type: "STATE" }> | undefined): unknown {
  const stores = (state?.cursor as { stores?: Array<{ store?: unknown; status?: unknown }> } | undefined)?.stores;
  return stores?.find((row) => row.store === "file_history")?.status;
}

test("claude_code: a run that fails after the inventory pass still commits fresh static coverage STATE", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-coverage-state-fail-"));
  await mkdir(join(claudeHome, "file-history"), { recursive: true });
  await writeFile(join(claudeHome, "file-history", "snapshot.json"), "{}");
  // CLAUDE_CODE_PROJECTS_DIR is genuinely absent — assertRequestedClaudeSources
  // throws for `sessions`, AFTER buildLocalSourceInventory/emitCoverageDiagnostics/
  // emitCoverageDiagnosticsState (the early call) have already run.
  const projectsDir = join(claudeHome, "projects-missing");

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "file_history" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed", "the run must genuinely fail after the inventory pass, not succeed");

  const coverageStates = states(result.messages, "coverage_diagnostics");
  assert.equal(
    coverageStates.length,
    1,
    "only the early static write should land — collect() never reached the final write"
  );
  assert.equal(
    fileHistoryStatus(coverageStates.at(0)),
    "inventory_only",
    "the static snapshot committed before the failure must still classify file_history fresh, not stale"
  );
});
