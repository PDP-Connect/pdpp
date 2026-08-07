// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { collectChildProcessOutput } from "./child-process-output.ts";

test("test output is retained when process exit precedes stdio close", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    stdout: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const captured = collectChildProcessOutput(child);
  child.emit("exit", 0, null);
  child.stdout.end("stdout after exit\n");
  child.stderr.end("stderr after exit\n");
  child.emit("close", 0, null);

  assert.equal(await captured, "stdout after exit\nstderr after exit\n");
});
