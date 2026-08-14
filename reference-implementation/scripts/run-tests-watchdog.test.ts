// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { startFileProcessWatchdog } from "./file-process-watchdog.ts";

test("reporter progress extends the idle budget but not the hard deadline", () => {
  let now = 0;
  let tick: (() => void) | undefined;
  let killed = 0;
  const timer = { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;

  const watchdog = startFileProcessWatchdog({
    hardDeadlineMs: 300,
    idleBudgetMs: 100,
    kill: () => {
      killed += 1;
    },
    now: () => now,
    schedule: (callback) => {
      tick = callback;
      return timer;
    },
  });

  now = 99;
  tick?.();
  assert.equal(killed, 0);
  watchdog.markProgress();

  now = 190;
  tick?.();
  assert.equal(killed, 0, "progress keeps a finite file inside the idle budget");
  watchdog.markProgress();

  now = 289;
  tick?.();
  assert.equal(killed, 0, "progress can extend total runtime beyond the idle budget");

  now = 300;
  tick?.();
  assert.equal(killed, 1, "the absolute deadline still bounds a progressing process");
  assert.equal(watchdog.timeoutReason(), "hard");
});

test("the idle watchdog terminates a silent child", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("silent child did not become ready")), 5000);
      guard.unref?.();
      child.stdout?.once("data", () => {
        clearTimeout(guard);
        resolve();
      });
      child.once("error", reject);
    });

    const watchdog = startFileProcessWatchdog({
      hardDeadlineMs: 5000,
      idleBudgetMs: 300,
      kill: () => child.kill("SIGKILL"),
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("silent child survived its idle budget")), 8000);
      guard.unref?.();
      child.once("close", (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal });
      });
      child.once("error", reject);
    });

    watchdog.clear();
    assert.equal(watchdog.timeoutReason(), "idle");
    assert.equal(child.killed, true);
    assert.ok(result.signal === "SIGKILL" || result.code !== 0, "the silent child must not exit successfully");
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }
});
