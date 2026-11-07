// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run only by run-command.test.ts, as a child `node --test`: kill a wrapper's owner while
// its command and a background child are alive, then fail an assertion. The parent checks
// the run still exits and both processes are gone.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const wrapperPath = new URL("../run-command.ts", import.meta.url).pathname;
const PIDS = /^\d+ \d+\n$/;

// Shorter than the parent's 60 s timeout, so a stuck setup fails here and runs this file's after-hooks.
const READY_DEADLINE_MS = 20_000;

/** Wait for the shell's readiness sentinel: its own pid and its background child's, written once both exist. */
async function readyPids(sentinel: string): Promise<string> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded by READY_DEADLINE_MS.
    const text = await readFile(sentinel, "utf8").catch(() => "");
    if (PIDS.test(text)) {
      return text;
    }
    await sleep(25);
  }
  throw new Error("setup failed: the command never reported its pids");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("owner killed while its command and a background child run, then an assertion fails", async (t) => {
  const fx = await lifecycleFixture(t);
  const sentinel = fx.path("ready");
  // The background child inherits the wrapper's pipes, as it did in the CI hang.
  const wrapper = fx.spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      wrapperPath,
      "--",
      "sh",
      "-c",
      'sleep 300 & echo "$$ $!" > "$1.tmp" && mv "$1.tmp" "$1"; sleep 300',
      "sh",
      sentinel,
    ],
    { helpers: [sentinel] }
  );
  const pids = await readyPids(sentinel);
  // Let a command that fails at startup finish failing, then require the leak this test needs.
  await sleep(200);
  const gone = pids
    .trim()
    .split(" ")
    .filter((pid) => !alive(Number(pid)));
  if (gone.length > 0 || wrapper.exitCode !== null || wrapper.signalCode !== null) {
    throw new Error(`setup failed: the command or its background child is not running (gone: ${gone.join(",")})`);
  }
  await writeFile(process.env.PIDS_OUT as string, pids);
  wrapper.kill("SIGKILL");
  assert.fail("deliberate failure while an orphaned command holds the wrapper's pipes");
});
