// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createAttemptWatchdog } from "../runtime/scheduler/run-executor.ts";

test("local-only phase has a secondary wall-clock ceiling", async () => {
  const watchdog = createAttemptWatchdog(20);
  try {
    watchdog.markProgress({ phase_boundary: "local_only_phase_started" });
    const timedOut = await Promise.race([
      new Promise<boolean>((resolve) => {
        watchdog.signal.addEventListener("abort", () => resolve(true), { once: true });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    assert.equal(timedOut, true, "a local-only hang must hit the secondary ceiling");
    assert.equal(watchdog.timedOut(), true);
  } finally {
    watchdog.clear();
  }
});

test("a normal bounded watchdog still times out without the phase boundary", async () => {
  const watchdog = createAttemptWatchdog(20);
  try {
    const timedOut = await new Promise<boolean>((resolve) => {
      watchdog.signal.addEventListener("abort", () => resolve(true), { once: true });
    });
    assert.equal(timedOut, true);
    assert.equal(watchdog.timedOut(), true);
  } finally {
    watchdog.clear();
  }
});
