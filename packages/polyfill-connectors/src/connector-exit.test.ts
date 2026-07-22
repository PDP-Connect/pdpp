// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { flushAndExitAfterRuntimeAck } from "./connector-exit.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("flushAndExitAfterRuntimeAck waits for runtime stdin EOF before exit", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exitCode: number | null = null;

  flushAndExitAfterRuntimeAck(0, {
    exit: (code) => {
      exitCode = code;
    },
    runtimeAckTimeoutMs: 1000,
    stdin,
    stdout,
  });

  await delay(10);
  assert.equal(exitCode, null);
  stdin.emit("end");
  await delay(10);
  assert.equal(exitCode, 0);
});

test("flushAndExitAfterRuntimeAck does not use stdout drain timeout as runtime ACK", async () => {
  const stdin = new PassThrough();
  const stdout = new EventEmitter() as EventEmitter & { writableLength: number };
  stdout.writableLength = 1;
  let exitCode: number | null = null;

  flushAndExitAfterRuntimeAck(0, {
    exit: (code) => {
      exitCode = code;
    },
    runtimeAckTimeoutMs: 1000,
    stdin,
    stdout,
    stdoutDrainTimeoutMs: 10,
  });

  await delay(30);
  assert.equal(exitCode, null);
  stdin.emit("end");
  await delay(10);
  assert.equal(exitCode, 0);
});
