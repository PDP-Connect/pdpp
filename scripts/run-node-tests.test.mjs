// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { localNodeTestArgs } from "./run-node-tests.mjs";

test("local Node test commands default to two concurrent files", () => {
  assert.deepEqual(localNodeTestArgs(["--test", "example.test.mjs"], false), [
    "--test",
    "--test-concurrency=2",
    "example.test.mjs",
  ]);
});

test("CI and explicit concurrency preserve the caller's command", () => {
  assert.deepEqual(localNodeTestArgs(["--test", "example.test.mjs"], true), ["--test", "example.test.mjs"]);
  assert.deepEqual(localNodeTestArgs(["--test", "--test-concurrency=1", "example.test.mjs"], false), [
    "--test",
    "--test-concurrency=1",
    "example.test.mjs",
  ]);
});
