// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createScheduler } from "../runtime/scheduler.ts";

const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { recommended_mode: "automatic", background_safe: true },
  },
  streams: [{ name: "items" }],
};

function writeCountingConnector(tmpDir) {
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

function readAttempts(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for scheduler condition after ${timeoutMs}ms`);
}

test("scheduled static-secret credential rejection suppresses repeated automatic attempts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-static-secret-repair-"));
  const { attemptsPath, connectorPath } = writeCountingConnector(tmpDir);
  const completedRuns = [];
  const needsHuman = new Set();
  let resolveCalls = 0;

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: "chatgpt",
        connectorInstanceId: "cin_rejected_static_secret",
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    rsUrl: "http://localhost.invalid",
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: (record) => completedRuns.push(record),
    isNeedsHuman: (_connectorId, instanceId) => needsHuman.has(instanceId),
    markNeedsHuman: (_connectorId, instanceId) => needsHuman.add(instanceId),
    resolveStaticSecretRunEnv: async () => {
      resolveCalls += 1;
      const err = new Error("stored credential rejected by provider");
      err.code = "credential_rejected";
      throw err;
    },
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    scheduler.stop();

    assert.deepEqual(readAttempts(attemptsPath), [], "connector must not spawn with a rejected stored credential");
    assert.equal(resolveCalls, 1, "needs-human suppression must prevent repeated credential recovery attempts");
    assert.equal(completedRuns[0].status, "skipped");
    assert.match(completedRuns[0].error, /^needs_human_attention: credential_rejected:/);
    assert.equal(
      completedRuns.some((record) => record.status === "failed"),
      false,
      "credential repair state must not deepen scheduler failure/backoff history"
    );
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
