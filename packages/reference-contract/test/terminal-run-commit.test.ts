// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalTerminalRunCommitJson } from "../src/common/terminal-run-commit.ts";

test("terminal run commit canonical envelope has a stable cross-runtime golden hash", () => {
  const canonical = canonicalTerminalRunCommitJson({
    collection_boundary: "unscoped",
    commit_id: "commit-1",
    connector_id: "codex",
    connector_instance_id: "cin-1",
    device_id: "dev-1",
    run_id: "run-1",
    source_instance_id: "src-1",
    state_delta: { z: { cursor: 2 }, a: { cursor: 1 } },
    terminal_facts: [
      { coverage_statuses: ["missing", "collected", "missing"], stream: "z" },
      { coverage_statuses: ["collected"], scoped: false, stream: "a" },
    ],
    version: 1,
  });
  assert.equal(
    canonical,
    '{"collection_boundary":"unscoped","commit_id":"commit-1","connector_id":"codex","connector_instance_id":"cin-1","device_id":"dev-1","run_id":"run-1","source_instance_id":"src-1","state_delta":{"a":{"cursor":1},"z":{"cursor":2}},"terminal_facts":[{"coverage_statuses":["collected"],"scoped":false,"stream":"a"},{"coverage_statuses":["collected","missing"],"stream":"z"}],"version":1}'
  );
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    "147b0baeb81e66a5dfb3f0862596d50aeb87fe8a6723306740e9446dddb72648"
  );
});
