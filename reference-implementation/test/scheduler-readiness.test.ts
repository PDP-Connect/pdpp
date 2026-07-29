// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { defaultReadinessChecker } from "../runtime/scheduler-readiness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExternalTool {
  readonly detect?: { readonly args?: readonly string[]; readonly executable?: string; readonly exit_code?: number };
  readonly license?: string;
  readonly name?: string;
  readonly purpose?: string;
}

function scheduleWithTool(tool: ExternalTool): ConnectorSchedule {
  return {
    connectorId: "readiness-test",
    connectorPath: "/tmp/readiness-test",
    intervalMs: 60_000,
    manifest: {
      runtime_requirements: {
        external_tools: [tool],
      },
    },
    ownerToken: "owner-token-readiness-test",
  };
}

test("structured external-tool detector executes executable with explicit args", async () => {
  const readiness = await defaultReadinessChecker(
    scheduleWithTool({
      detect: { args: ["-e", "process.exit(0)"], executable: process.execPath, exit_code: 0 },
      license: "test-only",
      name: "node",
      purpose: "Prove structured external-tool detection",
    })
  );

  assert.equal(readiness.ready, true);
});

test("external-tool detector does not interpret shell command strings", async () => {
  const readiness = await defaultReadinessChecker(
    scheduleWithTool({
      detect: { executable: `${process.execPath} -e "process.exit(0)"`, exit_code: 0 },
      license: "test-only",
      name: "node-shell-string",
      purpose: "Prove shell syntax is not interpreted",
    })
  );

  assert.equal(readiness.ready, false);
  assert.ok(readiness.reason);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(readiness.reason, /required external tool node-shell-string is not available/u);
});

test("scheduler readiness implementation does not request shell execution", () => {
  const source = readFileSync(join(__dirname, "..", "runtime", "scheduler-readiness.ts"), "utf8");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(source, /shell\s*:\s*true/u);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(source, /spawn\s*\(\s*command/u);
});
