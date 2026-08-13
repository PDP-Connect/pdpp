// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { applyLocalNodeTestConcurrency, assertIssuedArgvMatchesCommand } from "./authority.ts";

const ARGV_MISMATCH_PATTERN = /differs from the argv bound/;

test("local direct Node test leaves run at most two files concurrently", () => {
  assert.deepEqual(applyLocalNodeTestConcurrency(["node", "--test", "--import", "tsx"], false), [
    "node",
    "--test",
    "--test-concurrency=2",
    "--import",
    "tsx",
  ]);
});

test("CI and explicitly bounded commands preserve their declared concurrency", () => {
  const command = ["node", "--test", "--import", "tsx"];
  assert.deepEqual(applyLocalNodeTestConcurrency(command, true), command);
  assert.deepEqual(applyLocalNodeTestConcurrency(["node", "--test", "--test-concurrency=1"], false), [
    "node",
    "--test",
    "--test-concurrency=1",
  ]);
});

test("non-test Node commands are unchanged", () => {
  const command = ["node", "--import", "tsx", "scripts/run-tests.ts"];
  assert.deepEqual(applyLocalNodeTestConcurrency(command, false), command);
});

test("executed commands must retain the argv bound into authority transcripts and receipts", () => {
  const issued = ["node", "--test", "--test-concurrency=2", "--import", "tsx"];
  assert.doesNotThrow(() => assertIssuedArgvMatchesCommand(issued, [...issued, "example.test.ts"]));
  assert.throws(
    () => assertIssuedArgvMatchesCommand(issued, ["node", "--test", "--import", "tsx", "example.test.ts"]),
    ARGV_MISMATCH_PATTERN
  );
});
