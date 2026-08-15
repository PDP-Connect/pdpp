// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";

const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: true, recommended_mode: "automatic" },
  },
  streams: [{ name: "items" }],
};

function writeCountingConnector(tmpDir: string) {
  const attemptsPath = join(tmpDir, "attempts.log");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  appendFileSync(${JSON.stringify(attemptsPath)}, "spawned\\n");
  process.stdout.write(JSON.stringify({
    type: "DONE",
    status: "succeeded",
    records_emitted: 0
  }) + "\\n");
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return { attemptsPath, connectorPath };
}

function readAttempts(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for scheduler condition after ${timeoutMs}ms`);
}

test("scheduled static-secret credential rejection suppresses repeated automatic attempts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-static-secret-repair-"));
  const { attemptsPath, connectorPath } = writeCountingConnector(tmpDir);
  const completedRuns: RunRecord[] = [];
  const needsHuman = new Set();
  let resolveCalls = 0;

  const scheduler = createScheduler({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? "cin_rejected_static_secret",
        ownerSubjectId: ownerSubjectId ?? "owner-repair",
      }),
    connectors: [
      {
        connectorId: "chatgpt",
        connectorInstanceId: "cin_rejected_static_secret",
        connectorPath,
        intervalMs: 25,
        manifest: BACKGROUND_SAFE_MANIFEST,
        maxRetries: 0,
        ownerSubjectId: "owner-repair",
        ownerToken: "owner-token",
      },
    ],
    isNeedsHuman: (_connectorId, instanceId) => needsHuman.has(instanceId),
    markNeedsHuman: (_connectorId, instanceId) => needsHuman.add(instanceId),
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: (record) => completedRuns.push(record),
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    resolveStaticSecretRunEnv: async () => {
      resolveCalls += 1;
      const err: Error & { code?: string } = new Error("stored credential rejected by provider");
      err.code = "credential_rejected";
      throw err;
    },
    rsUrl: "http://localhost.invalid",
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    scheduler.stop();

    assert.deepEqual(readAttempts(attemptsPath), [], "connector must not spawn with a rejected stored credential");
    assert.equal(resolveCalls, 1, "needs-human suppression must prevent repeated credential recovery attempts");
    const [firstRun] = completedRuns;
    assert.ok(firstRun, "expected at least one completed run");
    assert.equal(firstRun.status, "skipped");
    assert.ok(firstRun.error, "expected the skipped run to carry an error message");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(firstRun.error, /^needs_human_attention: credential_rejected:/);
    assert.equal(
      completedRuns.some((record) => record.status === "failed"),
      false,
      "credential repair state must not deepen scheduler failure/backoff history"
    );
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
