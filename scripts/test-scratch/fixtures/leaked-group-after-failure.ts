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
const PID_FILE = /^\d+\n$/;

// Shorter than the parent's 60 s timeout, so a stuck setup fails here and runs this file's after-hooks.
const READY_DEADLINE_MS = 20_000;

// Each program publishes its own pid from inside the running process, atomically, once it is up.
const PUBLISH =
  'const f=require("node:fs");const w=(p)=>{f.writeFileSync(p+".tmp",process.pid+"\\n");f.renameSync(p+".tmp",p)};';
// The background keep-alive. It inherits the wrapper's pipes, as the background child did in the CI hang.
const KEEP_ALIVE = `${PUBLISH}w(process.argv[1]);setInterval(()=>{},1e6)`;
// The command (owner). It publishes only after its keep-alive child reports ready, and exits at once if that child exits.
const COMMAND = `${PUBLISH}const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(KEEP_ALIVE)},process.argv[2]],{stdio:"inherit"});c.on("exit",()=>process.exit(1));c.on("error",()=>process.exit(1));const t=setInterval(()=>{if(f.existsSync(process.argv[2])){clearInterval(t);w(process.argv[1]);setInterval(()=>{},1e6)}},10)`;

/** Wait for both self-reported pids: the command's and its background child's. */
async function readyPids(ownerFile: string, childFile: string): Promise<[number, number]> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded by READY_DEADLINE_MS.
    const owner = await readFile(ownerFile, "utf8").catch(() => "");
    const child = await readFile(childFile, "utf8").catch(() => "");
    if (PID_FILE.test(owner) && PID_FILE.test(child)) {
      return [Number(owner), Number(child)];
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
  const ownerFile = fx.path("owner-pid");
  const childFile = fx.path("child-pid");
  const wrapper = fx.spawn(
    process.execPath,
    ["--import", "tsx", wrapperPath, "--", process.execPath, "-e", COMMAND, ownerFile, childFile],
    { helpers: [ownerFile, childFile] }
  );
  const pids = await readyPids(ownerFile, childFile);
  const gone = pids.filter((pid) => !alive(pid));
  if (gone.length > 0 || wrapper.exitCode !== null || wrapper.signalCode !== null) {
    throw new Error(`setup failed: the command or its background child is not running (gone: ${gone.join(",")})`);
  }
  await writeFile(process.env.PIDS_OUT as string, `${pids.join(" ")}\n`);
  wrapper.kill("SIGKILL");
  assert.fail("deliberate failure while an orphaned command holds the wrapper's pipes");
});
