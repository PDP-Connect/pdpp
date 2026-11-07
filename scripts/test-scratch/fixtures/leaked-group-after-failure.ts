// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run only by run-command.test.ts, as a child `node --test`: kill a wrapper's owner while
// its command group is alive, then fail an assertion. The parent checks the run still
// exits and the group is gone.

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const wrapperPath = new URL("../run-command.ts", import.meta.url).pathname;

async function runningGroup(scratchParent: string): Promise<number> {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded by the parent test's timeout.
    const [root] = (await readdir(scratchParent).catch(() => [] as string[])).filter((name) => name.startsWith("run-"));
    const text = root
      ? await readFile(join(scratchParent, root, ".pdpp-test-scratch.json"), "utf8").catch(() => "{}")
      : "{}";
    const marker = JSON.parse(text) as { pgid?: unknown; state?: unknown };
    if (marker.state === "running" && typeof marker.pgid === "number") {
      return marker.pgid;
    }
    await sleep(25);
  }
}

test("owner killed while its command group runs, then an assertion fails", async (t) => {
  const fx = await lifecycleFixture(t);
  // The background child inherits the wrapper's pipes, as it did in the CI hang.
  const wrapper = fx.spawn(process.execPath, [
    "--import",
    "tsx",
    wrapperPath,
    "--",
    "sh",
    "-c",
    "sleep 300 & sleep 300",
  ]);
  await writeFile(process.env.GROUP_OUT as string, String(await runningGroup(fx.scratchParent)));
  wrapper.kill("SIGKILL");
  assert.fail("deliberate failure while an orphaned command group holds the wrapper's pipes");
});
