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
 * Regression coverage for the "advertised stream honesty" follow-up: the
 * inventory pass that classifies static stores (shell_snapshots, history,
 * session_index, config_inventory, cache_inventory) runs BEFORE rollout
 * scanning and has nothing to do with it. Before this fix, the
 * `coverage_diagnostics` STATE cursor was written exactly once, at the very
 * end of `main()`, combined with derived (messages/function_calls) coverage.
 * A run that fails partway through rollout scanning — or any step after the
 * inventory pass — never reached that write, so the durable checkpoint
 * (what `readCommittedLocalCoverageDiagnostics`/the coverage axis actually
 * reads) kept whatever per-store classification was committed on some
 * earlier run, even though a fresh `coverage_diagnostics` RECORD for every
 * store (including the correctly-reclassified one) was already emitted and
 * durably ingested moments earlier in the SAME run.
 *
 * The fix commits the static snapshot as its own STATE write immediately
 * after the inventory pass. A later full success still supersedes it with
 * the richer static+derived snapshot (last-wins per stream); a mid-run
 * failure now leaves the static proof committed instead of discarded.
 */

function states(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> => msg.type === "STATE" && msg.stream === stream
  );
}

function shellSnapshotsStatus(state: Extract<EmittedMessage, { type: "STATE" }> | undefined): unknown {
  const stores = (state?.cursor as { stores?: Array<{ store?: unknown; status?: unknown }> } | undefined)?.stores;
  return stores?.find((row) => row.store === "shell_snapshots")?.status;
}

test("codex: a successful complete run writes static coverage STATE, then a richer combined snapshot", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-coverage-state-"));
  await mkdir(join(codexHome, "shell-snapshots"), { recursive: true });
  await writeFile(join(codexHome, "shell-snapshots", "snapshot-1.sh"), "#!/bin/sh\necho hi\n");

  const result = await runConnectorProtocolSubprocess({
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: codexHome },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "shell_snapshots" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const coverageStates = states(result.messages, "coverage_diagnostics");
  // Two writes: the early static-only snapshot, then the final combined one.
  assert.equal(coverageStates.length, 2, "expected an early static write and a final combined write");
  for (const state of coverageStates) {
    assert.equal(
      shellSnapshotsStatus(state),
      "inventory_only",
      "every committed snapshot must classify shell_snapshots fresh"
    );
  }
});

test("codex: a run that fails after the inventory pass still commits fresh static coverage STATE", async () => {
  // `sessions` is a FILE (not a directory) so `checkDirectoryReadable`
  // returns "unreadable" without relying on chmod (which a root test runner
  // ignores) — assertRequestedCodexSources throws for a genuine I/O-shaped
  // failure, AFTER buildLocalSourceInventory/emitCoverageDiagnostics/
  // emitStaticCoverageState have already run.
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-coverage-state-fail-"));
  await mkdir(join(codexHome, "shell-snapshots"), { recursive: true });
  await writeFile(join(codexHome, "shell-snapshots", "snapshot-1.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(codexHome, "sessions"), "not a directory");

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: codexHome },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "shell_snapshots" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed", "the run must genuinely fail after the inventory pass, not succeed");

  const coverageStates = states(result.messages, "coverage_diagnostics");
  assert.equal(
    coverageStates.length,
    1,
    "only the early static write should land — main() never reached the final combined write"
  );
  assert.equal(
    shellSnapshotsStatus(coverageStates.at(0)),
    "inventory_only",
    "the static snapshot committed before the failure must still classify shell_snapshots fresh, not stale"
  );
});
