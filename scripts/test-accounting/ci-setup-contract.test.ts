// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const CHILD_CONCURRENCY_PATTERN = /^childConcurrency: 1$/m;
const INSTALL_PATTERN = /pnpm install/;
const IGNORE_SCRIPTS_PATTERN = /--ignore-scripts/;
const INVENTORY_BASE_PATTERN = /node -p 'require\("\.\/test-accounting\.manifest\.json"\)\.inventory_base_sha'/;
const FETCH_BASE_PATTERN = /git fetch --no-tags origin "\$base_sha"/;
const COMMENT_PATTERN = /^\s*#.*$/gm;
const GATE_COMMAND = "pnpm test-accounting:check";
const INLINE_RUN_PATTERN = /^\s*(?:-\s+)?run:\s*(["']?)pnpm test-accounting:check\1\s*$/m;
const BLOCK_RUN_PATTERN = /^\s*(?:-\s+)?run:\s*[|>][-+]?\s*\n\s+pnpm test-accounting:check\s*$/m;
const PULL_REQUEST_KEY_PATTERN = /^(\s*)["']?pull_request["']?:\s*(\{\s*\}|null|~)?\s*$/m;
const RUNS_ON_PATTERN = /^(\s*)runs-on:/m;
const ANCESTOR_PATTERN = /git merge-base --is-ancestor "\$base_sha" HEAD/;

test("root pnpm config serializes workspace lifecycle children for every installer", async () => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  assert.match(workspace, CHILD_CONCURRENCY_PATTERN);

  const vercel = JSON.parse(await readFile(new URL("vercel.json", root), "utf8")) as { installCommand: string };
  assert.match(vercel.installCommand, INSTALL_PATTERN);
  assert.doesNotMatch(vercel.installCommand, IGNORE_SCRIPTS_PATTERN);
});

test("inventory workflow explicitly fetches and verifies the manifest baseline", async () => {
  const workflow = await readFile(new URL(".github/workflows/test-accounting.yml", root), "utf8");
  assert.match(workflow, INVENTORY_BASE_PATTERN);
  assert.match(workflow, FETCH_BASE_PATTERN);
  assert.match(workflow, ANCESTOR_PATTERN);
});

/**
 * Reasons the workflow text fails to be an unfiltered whole-workspace gate.
 * Textual rather than a YAML parse: no YAML parser is a root dependency (yaml
 * is only transitive), so this tolerates quoting, block scalars, indentation
 * and null-valued triggers but still rejects a path-filtered pull_request, a
 * missing gate command and a job-level `if:`.
 */
export function workspaceGateProblems(raw: string): string[] {
  const text = raw.replace(COMMENT_PATTERN, "");
  const problems: string[] = [];
  if (!(INLINE_RUN_PATTERN.test(text) || BLOCK_RUN_PATTERN.test(text))) {
    problems.push(`no step runs ${GATE_COMMAND}`);
  }
  const trigger = PULL_REQUEST_KEY_PATTERN.exec(text);
  if (trigger) {
    const indent = trigger[1].length;
    const after = text.slice(trigger.index + trigger[0].length).split("\n");
    const next = after.find((line) => line.trim() !== "");
    if (next && next.length - next.trimStart().length > indent) {
      problems.push("pull_request has filters");
    }
  } else {
    problems.push("no pull_request trigger");
  }
  const runsOn = RUNS_ON_PATTERN.exec(text);
  if (runsOn && new RegExp(`^${runsOn[1]}if:`, "m").test(text)) {
    problems.push("job has an if: condition");
  }
  return problems;
}

const GATE_WORKFLOW = `name: x
on:
  push:
    branches: [main]
  pull_request: {}
jobs:
  workspace:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: pnpm test-accounting:check
      - if: failure()
        run: echo evidence
`;

test("workspace gate workflow exists and is an unfiltered full-suite gate", async () => {
  const workflow = await readFile(new URL(".github/workflows/workspace-tests.yml", root), "utf8");
  assert.deepEqual(workspaceGateProblems(workflow), []);
  assert.match(workflow, INVENTORY_BASE_PATTERN);
  assert.match(workflow, FETCH_BASE_PATTERN);
  assert.match(workflow, ANCESTOR_PATTERN);
});

test("workspace gate check accepts equivalent reformatting", () => {
  const reformatted = GATE_WORKFLOW.replace("pull_request: {}", "pull_request:")
    .replace("run: pnpm test-accounting:check", 'run: "pnpm test-accounting:check"')
    .replaceAll("  ", "    ");
  assert.deepEqual(workspaceGateProblems(reformatted), []);
  const block = GATE_WORKFLOW.replace(
    "run: pnpm test-accounting:check",
    "run: |\n          pnpm test-accounting:check"
  );
  assert.deepEqual(workspaceGateProblems(block), []);
});

test("workspace gate check rejects a removed gate, a filtered pull_request and a disabled job", () => {
  assert.deepEqual(workspaceGateProblems(GATE_WORKFLOW.replace("pnpm test-accounting:check", "pnpm test")), [
    `no step runs ${GATE_COMMAND}`,
  ]);
  assert.deepEqual(
    workspaceGateProblems(GATE_WORKFLOW.replace("pull_request: {}", "pull_request:\n    paths:\n      - apps/**")),
    ["pull_request has filters"]
  );
  assert.deepEqual(workspaceGateProblems(GATE_WORKFLOW.replace("  pull_request: {}\n", "")), [
    "no pull_request trigger",
  ]);
  assert.deepEqual(workspaceGateProblems(GATE_WORKFLOW.replace("    runs-on:", "    if: false\n    runs-on:")), [
    "job has an if: condition",
  ]);
});
