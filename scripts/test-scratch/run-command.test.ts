// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import {
  allocateScratchOwnership,
  cleanupScratchOwnership,
  inheritedScratchOwnership,
  recoverStaleScratch,
  scratchCandidateSafetyReason,
} from "./ownership.ts";
import { runScratchCommand } from "./run-command.ts";

const child = new URL("./fixtures/child.ts", import.meta.url).pathname;
const CHILD_SIGINT_OUTPUT = /child-signal:SIGINT/;
const CHILD_SIGTERM_OUTPUT = /child-signal:SIGTERM/;
const GROUP_STILL_LIVE_OUTPUT = /group-still-live/;
const LINUX_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function temporaryParent(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdpp-test-scratch-test-"));
}

function command(args: string[]): string[] {
  return ["--", process.execPath, "--import", "tsx", child, ...args];
}

const SANDBOX_SCRIPT = new URL("../test-sandbox/test-sandbox", import.meta.url).pathname;
const wrapperPath = new URL("./run-command.ts", import.meta.url).pathname;
const lifecycleWrapperPath = new URL("./fixtures/lifecycle-wrapper.ts", import.meta.url).pathname;
const delayedPublishWrapperPath = new URL("./fixtures/delayed-publish-wrapper.ts", import.meta.url).pathname;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function startWrapper(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawn(process.execPath, ["--import", "tsx", wrapperPath, ...command(args)], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function startRawWrapper(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawn(process.execPath, ["--import", "tsx", wrapperPath, "--", ...argv], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("owner routes children through the sandbox unless explicitly disabled", async () => {
  const runnerTemp = await temporaryParent();
  const probe = [
    process.execPath,
    "-e",
    "console.log(JSON.stringify({active:process.env.TEST_SANDBOX_ACTIVE||null,tmp:process.env.TMPDIR,mode:require('node:fs').statSync(process.env.TMPDIR).mode%0o1000}))",
  ];
  try {
    for (const disabled of [false, true]) {
      const env = {
        ...process.env,
        PDPP_TEST_SCRATCH_ROOT: undefined,
        PDPP_TEST_SCRATCH_SCHEMA: undefined,
        PDPP_TEST_SCRATCH_MARKER: undefined,
        PDPP_TEST_SCRATCH_NONCE: undefined,
        PDPP_TEST_SCRATCH_OWNER_PID: undefined,
        RUNNER_TEMP: runnerTemp,
        TEST_SANDBOX_ACTIVE: "",
        TEST_SANDBOX_DISABLE: disabled ? "1" : "0",
      };
      const wrapper = startRawWrapper(probe, env);
      let stdout = "";
      wrapper.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      // biome-ignore lint/performance/noAwaitInLoops: exercise enabled and disabled launches sequentially.
      assert.deepEqual(await closed(wrapper), { code: 0, signal: null });
      const result = JSON.parse(stdout.trim()) as { active: string | null; tmp: string; mode: number };
      assert.equal(result.active, disabled ? null : "1");
      if (!disabled) {
        assert.equal(result.mode, 0o700);
      }
      assert.ok(result.tmp.includes("pdpp-test-scratch"));
      await assert.rejects(access(result.tmp));
    }
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("sandbox creates a missing --scratch root 0700 once and never re-creates it", async () => {
  const parent = await temporaryParent();
  const scratch = join(parent, "root");
  try {
    const run = (script: string) =>
      spawnSync(SANDBOX_SCRIPT, ["--scratch", scratch, "--", process.execPath, "-e", script], {
        encoding: "utf8",
        env: { ...process.env, TEST_SANDBOX_ACTIVE: "", TEST_SANDBOX_PIDNS: "0" },
      });
    // Loose parent umask: only the sandbox's own creation can make the root private.
    const previous = process.umask(0o022);
    try {
      const created = run("console.log(require('node:fs').statSync(process.env.TMPDIR).mode%0o1000)");
      assert.equal(created.status, 0, created.stderr);
      assert.equal(created.stdout.trim(), String(0o700));
      const removed = run("require('node:fs').rmSync(process.env.TMPDIR,{recursive:true})");
      assert.equal(removed.status, 0, removed.stderr);
    } finally {
      process.umask(previous);
    }
    await assert.rejects(access(scratch));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("sandbox preserves literal shell variable syntax in child argv", async () => {
  const runnerTemp = await temporaryParent();
  try {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise literal shell syntax across the launcher boundary.
    const wrapper = startRawWrapper(["bash", "-c", 'X=ok; printf %s "${X}"'], {
      ...process.env,
      PDPP_TEST_SCRATCH_ROOT: undefined,
      PDPP_TEST_SCRATCH_SCHEMA: undefined,
      PDPP_TEST_SCRATCH_MARKER: undefined,
      PDPP_TEST_SCRATCH_NONCE: undefined,
      PDPP_TEST_SCRATCH_OWNER_PID: undefined,
      RUNNER_TEMP: runnerTemp,
      TEST_SANDBOX_ACTIVE: "",
      TEST_SANDBOX_DISABLE: "0",
    });
    let output = "";
    wrapper.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    assert.deepEqual(await closed(wrapper), { code: 0, signal: null });
    assert.equal(output, "ok");
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("normal sandbox exit stops a background command child before scratch cleanup", async () => {
  const runnerTemp = await temporaryParent();
  const wrapper = startRawWrapper(
    ["bash", "-c", 'sleep 300 </dev/null >/dev/null 2>&1 & printf "%s\\n%s\\n" "$!" "$TMPDIR"'],
    {
      ...process.env,
      PDPP_TEST_SCRATCH_ROOT: undefined,
      PDPP_TEST_SCRATCH_SCHEMA: undefined,
      PDPP_TEST_SCRATCH_MARKER: undefined,
      PDPP_TEST_SCRATCH_NONCE: undefined,
      PDPP_TEST_SCRATCH_OWNER_PID: undefined,
      RUNNER_TEMP: runnerTemp,
      TEST_RECEIPT_ACTIVE: "1",
      TEST_SANDBOX_ACTIVE: "1",
      TEST_SANDBOX_DISABLE: "0",
    }
  );
  let output = "";
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let backgroundPid: number | undefined;
  try {
    const result = await closed(wrapper);
    const [pidLine, root] = output.trim().split("\n");
    backgroundPid = Number(pidLine);
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    assert.ok(root);
    assert.deepEqual(result, { code: 0, signal: null });
    await eventuallyAbsentProcess(backgroundPid);
    await assert.rejects(access(root));
  } finally {
    if (backgroundPid) {
      try {
        process.kill(backgroundPid, "SIGKILL");
      } catch {
        // The launcher may already have stopped the child.
      }
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("sandbox sees its owned scratch root below /tmp", {
  skip: process.platform !== "linux",
}, async () => {
  const runnerTemp = await mkdtemp(join("/tmp", "pdpp-test-sandbox-tmp-"));
  try {
    const wrapper = startRawWrapper(
      [
        process.execPath,
        "-e",
        'const fs=require("node:fs");const root=process.env.TMPDIR;fs.writeFileSync(root+"/visible","ok");console.log(JSON.stringify({root,active:process.env.TEST_SANDBOX_ACTIVE}))',
      ],
      {
        ...process.env,
        PDPP_TEST_SCRATCH_ROOT: undefined,
        PDPP_TEST_SCRATCH_SCHEMA: undefined,
        PDPP_TEST_SCRATCH_MARKER: undefined,
        PDPP_TEST_SCRATCH_NONCE: undefined,
        PDPP_TEST_SCRATCH_OWNER_PID: undefined,
        RUNNER_TEMP: runnerTemp,
        TEST_SANDBOX_ACTIVE: "",
        TEST_SANDBOX_DISABLE: "0",
      }
    );
    let output = "";
    wrapper.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    assert.deepEqual(await closed(wrapper), { code: 0, signal: null });
    const result = JSON.parse(output.trim()) as { root: string; active: string };
    assert.equal(result.active, "1");
    assert.ok(result.root.startsWith(`${runnerTemp}/pdpp-test-scratch/run-`));
    await assert.rejects(access(result.root));
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

function startLaunchingWrapper(env: NodeJS.ProcessEnv = process.env) {
  return spawn(process.execPath, ["--import", "tsx", lifecycleWrapperPath], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function reportedRoot(proc: ReturnType<typeof spawn>): Promise<string> {
  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 20_000);
    const observe = () => {
      const value = output.trim();
      if (value) {
        clearTimeout(deadline);
        resolve(value);
      }
    };
    proc.stdout?.on("data", observe);
    proc.once("error", reject);
  });
}

function closed(proc: ReturnType<typeof spawn>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function exited(proc: ReturnType<typeof spawn>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function currentBootId(): Promise<string | undefined> {
  return readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then((value) => {
      const bootId = value.trim();
      return LINUX_BOOT_ID.test(bootId) ? bootId : undefined;
    })
    .catch(() => undefined);
}

function differentBootId(bootId: string | undefined): string {
  const fallback = "00000000-0000-4000-8000-000000000000";
  if (!bootId) {
    return fallback;
  }
  return `${bootId[0] === "0" ? "1" : "0"}${bootId.slice(1)}`;
}

async function oldMarker(
  ownership: Awaited<ReturnType<typeof allocateScratchOwnership>>,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const rootStats = await stat(ownership.allocation.root);
  const pidNamespace = await readlink("/proc/self/ns/pid").catch(() => undefined);
  await writeFile(
    ownership.allocation.markerPath,
    `${JSON.stringify({
      created_at: new Date(Date.now() - 120_000).toISOString(),
      dev: rootStats.dev,
      ino: rootStats.ino,
      nonce: ownership.allocation.nonce,
      owner_pid: 999_999_999,
      pid_namespace: pidNamespace,
      parent: ownership.allocation.canonicalParent,
      root: ownership.allocation.root,
      schema: "pdpp.test-scratch/v1",
      state: "allocated",
      ...overrides,
    })}\n`
  );
}

async function eventuallyRead(path: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded fixture readiness polling.
      const value = await readFile(path, "utf8");
      if (value) {
        return value;
      }
      lastError = new Error(`fixture wrote an empty readiness file: ${path}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function eventuallyRunningMarker(
  path: string
): Promise<Record<string, unknown> & { pgid: number; state: string }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: marker state is published after the fixture reports its root.
    const marker = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & {
      pgid?: number;
      state: string;
    };
    if (marker.state === "running" && Number.isSafeInteger(marker.pgid)) {
      return marker as Record<string, unknown> & { pgid: number; state: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`scratch marker did not reach running state: ${path}`);
}

async function eventuallyRecover(parent: string, root: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for init to reap a killed orphan group.
    const results = await recoverStaleScratch({ parent });
    if (results.some((result) => result.path === root && result.reason === "dead-verified" && result.removed)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("killed orphan group was not recoverable");
}

async function eventuallyAbsentGroup(pgid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling observes init reaping a killed process group.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process group ${pgid} did not exit`);
}

async function eventuallyAbsentProcess(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling observes reaping after sandbox shutdown.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit`);
}

test("owner contains tmpdir writes, preserves numeric exits, and removes only its root", async () => {
  const parent = await temporaryParent();
  const ambient = await temporaryParent();
  const before = process.env.TMPDIR;
  process.env.TMPDIR = ambient;
  try {
    for (const code of [0, 1, 42, 130]) {
      // biome-ignore lint/performance/noAwaitInLoops: exact exit outcomes are asserted sequentially.
      const result = await runScratchCommand(command([`--exit=${code}`]));
      assert.deepEqual(result, { code, signal: null });
    }
    await writeFile(join(ambient, "sentinel"), "unchanged");
    assert.equal(await readFile(join(ambient, "sentinel"), "utf8"), "unchanged");
  } finally {
    if (before === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = before;
    }
    await rm(parent, { force: true, recursive: true });
    await rm(ambient, { force: true, recursive: true });
  }
});

test("cleanup unlinks an internal symlink but never traverses it", async () => {
  const parent = await temporaryParent();
  const victim = join(parent, "victim");
  await writeFile(victim, "do not delete");
  const ownership = await allocateScratchOwnership({ parent });
  await symlink(victim, join(ownership.allocation.root, "outside"));
  await cleanupScratchOwnership(ownership);
  assert.equal(await readFile(victim, "utf8"), "do not delete");
  await rm(parent, { force: true, recursive: true });
});

test("cleanup refuses a swapped root identity", async () => {
  const parent = await temporaryParent();
  const victim = join(parent, "victim");
  await writeFile(victim, "do not delete");
  const ownership = await allocateScratchOwnership({ parent });
  await rm(ownership.allocation.root, { force: true, recursive: true });
  await symlink(victim, ownership.allocation.root);
  await assert.rejects(cleanupScratchOwnership(ownership), {
    name: "ScratchOwnershipError",
    reason: "identity-mismatch",
  });
  assert.equal(await readFile(victim, "utf8"), "do not delete");
  await rm(parent, { force: true, recursive: true });
});

test("cleanup refuses a live recorded process group before quarantine", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  assert.ok(live.pid);
  try {
    await oldMarker(ownership, { pgid: live.pid, state: "running" });
    await assert.rejects(cleanupScratchOwnership(ownership), {
      name: "ScratchOwnershipError",
      reason: "group-live",
    });
    await access(ownership.allocation.root);
  } finally {
    process.kill(-live.pid, "SIGKILL");
    await eventuallyAbsentGroup(live.pid);
    await rm(parent, { force: true, recursive: true });
  }
});

test("participant creates no nested owner", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const keys = Object.keys(ownership.env) as Array<keyof NodeJS.ProcessEnv>;
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, ownership.env);
  try {
    const result = await runScratchCommand(command(["--exit=0"]));
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupScratchOwnership(ownership);
    await rm(parent, { force: true, recursive: true });
  }
});

test("participant validation fails closed when any inherited temporary path is altered", async () => {
  const parent = await temporaryParent();
  const outside = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  try {
    const altered = { ...ownership.env, TMPDIR: outside };
    await assert.rejects(inheritedScratchOwnership(altered), {
      name: "ScratchOwnershipError",
      reason: "invalid-inherited-ownership",
    });
    const nested = startRawWrapper([process.execPath, "--import", "tsx", child, "--exit=0"], altered);
    assert.deepEqual(await closed(nested), { code: 1, signal: null });
    await assert.rejects(access(join(outside, "child.txt")));
    await access(ownership.allocation.root);
  } finally {
    await cleanupScratchOwnership(ownership);
    await rm(parent, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("launch failure removes its allocated root and returns the infrastructure exit", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  try {
    const wrapper = startRawWrapper(["/definitely-not-a-pdpp-command"], { ...process.env, RUNNER_TEMP: runnerTemp });
    assert.deepEqual(await closed(wrapper), { code: 74, signal: null });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("an unproven group shutdown retains scratch and makes a successful command infrastructure-failed", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const result = await runScratchCommand(command(["--exit=0"]), { stopGroup: async () => false });
    assert.deepEqual(result, { code: 74, signal: null });
    const roots = (await readdir(parent)).filter((entry) => entry.startsWith("run-"));
    assert.equal(roots.length, 1);
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("a rejected group proof retains scratch but preserves the child result", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    for (const exitCode of [0, 42]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case must retain and reap its own live group before the next case.
      const result = await runScratchCommand(["--", "sh", "-c", `sleep 30 & exit ${exitCode}`], {
        stopGroup: (pgid) => {
          process.kill(-pgid, "SIGKILL");
          throw new Error("simulate rejected group proof");
        },
      });
      assert.deepEqual(result, { code: exitCode === 0 ? 74 : exitCode, signal: null });
      const roots = (await readdir(parent)).filter((entry) => entry.startsWith("run-"));
      assert.equal(roots.length, 1);
      const root = join(parent, roots[0] as string);
      await rm(root, { force: true, recursive: true });
    }
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("recovery retains fresh and malformed roots", async () => {
  const parent = await temporaryParent();
  const root = join(parent, "run-malformed");
  await mkdir(root, { mode: 0o700 });
  const result = await recoverStaleScratch({ parent });
  assert.deepEqual(result, [{ path: root, reason: "malformed-marker", removed: false }]);
  await rm(parent, { force: true, recursive: true });
});

function canEnterPidNamespace(): boolean {
  try {
    execFileSync("bwrap", ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

test("recovery retains a root from another PID namespace", { skip: platform() !== "linux" }, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  try {
    const originalRoot = await lstat(ownership.allocation.root);
    const marker = JSON.parse(await readFile(ownership.allocation.markerPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      ownership.allocation.markerPath,
      `${JSON.stringify({ ...marker, created_at: new Date(Date.now() - 120_000).toISOString() })}\n`
    );
    let recovered: Awaited<ReturnType<typeof recoverStaleScratch>>;
    if (canEnterPidNamespace()) {
      const code = `import { recoverStaleScratch } from ${JSON.stringify(new URL("./ownership.ts", import.meta.url).pathname)}; console.log(JSON.stringify(await recoverStaleScratch({ parent: ${JSON.stringify(parent)} })))`;
      const output = execFileSync(
        "bwrap",
        [
          "--dev-bind",
          "/",
          "/",
          "--unshare-pid",
          "--proc",
          "/proc",
          "--",
          process.execPath,
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          code,
        ],
        { encoding: "utf8" }
      );
      recovered = JSON.parse(output.trim());
    } else {
      // Keep the namespace check deterministic when a second namespace cannot be created.
      await writeFile(
        ownership.allocation.markerPath,
        `${JSON.stringify({ ...marker, created_at: new Date(Date.now() - 120_000).toISOString(), owner_pid: 999_999_999, pid_namespace: "pid:[0]" })}\n`
      );
      recovered = await recoverStaleScratch({ parent });
    }
    assert.deepEqual(recovered, [
      { path: ownership.allocation.root, reason: "pid-namespace-mismatch", removed: false },
    ]);
    const retainedRoot = await lstat(ownership.allocation.root);
    assert.equal(retainedRoot.ino, originalRoot.ino);
    assert.equal(retainedRoot.mode % 0o1000, 0o700);
    assert.equal(
      (JSON.parse(await readFile(ownership.allocation.markerPath, "utf8")) as { nonce: string }).nonce,
      ownership.allocation.nonce
    );
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

const FOREIGN_PID_NAMESPACE = "pid:[0]";

test("recovery retains a legacy marker without a PID namespace until the boot differs", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const sameBoot = await allocateScratchOwnership({ parent });
  const priorBoot = await allocateScratchOwnership({ parent });
  const bootId = await currentBootId();
  try {
    await oldMarker(sameBoot, { boot_id: bootId, pid_namespace: undefined });
    await oldMarker(priorBoot, { boot_id: differentBootId(bootId), pid_namespace: undefined });
    const results = await recoverStaleScratch({ parent });
    assert.deepEqual(
      results.find((result) => result.path === sameBoot.allocation.root),
      { path: sameBoot.allocation.root, reason: "pid-namespace-mismatch", removed: false }
    );
    // A different boot resolves the namespace ambiguity only when the current boot id is itself readable.
    assert.deepEqual(
      results.find((result) => result.path === priorBoot.allocation.root),
      bootId
        ? { path: priorBoot.allocation.root, reason: "dead-verified", removed: true }
        : { path: priorBoot.allocation.root, reason: "pid-namespace-mismatch", removed: false }
    );
    await access(sameBoot.allocation.root);
    if (bootId) {
      await assert.rejects(access(priorBoot.allocation.root));
    } else {
      await access(priorBoot.allocation.root);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("journal recovery retains a root whose owner is in another PID namespace", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const journal = join(parent, `.scratch-cleanup-${ownership.allocation.nonce}.json`);
  try {
    await oldMarker(ownership, { pid_namespace: FOREIGN_PID_NAMESPACE });
    await assert.rejects(
      cleanupScratchOwnership(ownership, {
        afterJournal: () => Promise.reject(new Error("simulate crash after journal")),
      })
    );
    const results = await recoverStaleScratch({ parent });
    assert.deepEqual(
      results.find((result) => result.path === journal),
      { path: journal, reason: "pid-namespace-mismatch", removed: false }
    );
    await access(journal);
    await access(ownership.allocation.root);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("quarantine recovery retains a quarantine whose owner is in another PID namespace", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const quarantine = join(parent, `.quarantine-${ownership.allocation.nonce}`);
  try {
    await oldMarker(ownership, { pid_namespace: FOREIGN_PID_NAMESPACE });
    await rename(ownership.allocation.root, quarantine);
    assert.deepEqual(await recoverStaleScratch({ parent }), [
      { path: quarantine, reason: "pid-namespace-mismatch", removed: false },
    ]);
    await access(quarantine);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("recovery retains a same-namespace live owner whose boot id differs", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  try {
    await oldMarker(ownership, { boot_id: differentBootId(await currentBootId()), owner_pid: process.pid });
    assert.deepEqual(await recoverStaleScratch({ parent }), [
      { path: ownership.allocation.root, reason: "owner-live", removed: false },
    ]);
    await access(ownership.allocation.root);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("journal recovery retains a same-namespace live owner whose boot id differs", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const journal = join(parent, `.scratch-cleanup-${ownership.allocation.nonce}.json`);
  try {
    await oldMarker(ownership, { boot_id: differentBootId(await currentBootId()), owner_pid: process.pid });
    await assert.rejects(
      cleanupScratchOwnership(ownership, {
        afterJournal: () => Promise.reject(new Error("simulate crash after journal")),
      })
    );
    const results = await recoverStaleScratch({ parent });
    assert.deepEqual(
      results.find((result) => result.path === journal),
      { path: journal, reason: "owner-live", removed: false }
    );
    await access(journal);
    await access(ownership.allocation.root);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("quarantine recovery retains a same-namespace live owner whose boot id differs", {
  skip: platform() !== "linux",
}, async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const quarantine = join(parent, `.quarantine-${ownership.allocation.nonce}`);
  try {
    await oldMarker(ownership, { boot_id: differentBootId(await currentBootId()), owner_pid: process.pid });
    await rename(ownership.allocation.root, quarantine);
    assert.deepEqual(await recoverStaleScratch({ parent }), [
      { path: quarantine, reason: "owner-live", removed: false },
    ]);
    await access(quarantine);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("recovery removes only a verified old dead allocation and retains a live owner", async () => {
  const parent = await temporaryParent();
  const stale = await allocateScratchOwnership({ parent });
  const staleStats = await stat(stale.allocation.root);
  const pidNamespace = await readlink("/proc/self/ns/pid").catch(() => undefined);
  await writeFile(
    stale.allocation.markerPath,
    `${JSON.stringify({
      created_at: new Date(Date.now() - 120_000).toISOString(),
      dev: staleStats.dev,
      ino: staleStats.ino,
      nonce: stale.allocation.nonce,
      owner_pid: 999_999_999,
      pid_namespace: pidNamespace,
      parent: stale.allocation.canonicalParent,
      root: stale.allocation.root,
      schema: "pdpp.test-scratch/v1",
      state: "allocated",
    })}\n`
  );
  const live = await allocateScratchOwnership({ parent });
  const recovered = await recoverStaleScratch({ parent });
  assert.deepEqual(
    recovered.sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: stale.allocation.root, reason: "dead-verified", removed: true },
      { path: live.allocation.root, reason: "fresh", removed: false },
    ].sort((left, right) => left.path.localeCompare(right.path))
  );
  await cleanupScratchOwnership(live);
  await rm(parent, { force: true, recursive: true });
});

test("recovery retains malformed nonce markers without renaming or deleting outside paths", async () => {
  const base = await temporaryParent();
  const parent = join(base, "parent");
  const outside = join(base, "outside");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "sentinel"), "outside remains");
  const invalidNonces = [
    "../outside",
    "nested/child",
    "/absolute-looking",
    "../../../outside",
    "C:\\absolute-looking",
    "\\\\server\\share",
    "..\\..\\outside",
    "%2f",
    "..%2f..%2foutside",
    "..／..／outside",
    posix.join("..", "outside"),
    win32.join("..", "outside"),
    win32.resolve("C:\\outside"),
  ];
  try {
    for (const nonce of invalidNonces) {
      // biome-ignore lint/performance/noAwaitInLoops: each candidate must retain its own invalid marker root.
      const ownership = await allocateScratchOwnership({ parent });
      await oldMarker(ownership, { nonce });
      const result = await recoverStaleScratch({ parent });
      assert.deepEqual(
        result.find((candidate) => candidate.path === ownership.allocation.root),
        { path: ownership.allocation.root, reason: "malformed-marker", removed: false }
      );
      await access(ownership.allocation.root);
      assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside remains");
      assert.ok(!(await readdir(parent)).some((entry) => entry.startsWith(".quarantine-")));
    }
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

test("cleanup rejects a forged nonce before constructing a quarantine target", async () => {
  const base = await temporaryParent();
  const parent = join(base, "parent");
  const outside = join(base, "outside");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "sentinel"), "outside remains");
  const ownership = await allocateScratchOwnership({ parent });
  try {
    const forged = { ...ownership, allocation: { ...ownership.allocation, nonce: "../../../outside" } };
    await assert.rejects(cleanupScratchOwnership(forged), {
      name: "ScratchOwnershipError",
      reason: "invalid-nonce",
    });
    await access(ownership.allocation.root);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside remains");
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

test("CLI child signal remains a signal to its parent", async () => {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", new URL("./run-command.ts", import.meta.url).pathname, ...command(["--self-signal=SIGTERM"])],
      {
        stdio: "ignore",
      }
    );
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
});

test("SIGTERM reaches the owned group and cleanup completes before wrapper termination", async () => {
  let output = "";
  const wrapper = spawn(
    process.execPath,
    ["--import", "tsx", new URL("./run-command.ts", import.meta.url).pathname, ...command(["--print-root", "--wait"])],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const root = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 20_000);
    const observe = () => {
      const value = output.trim();
      if (value) {
        clearTimeout(deadline);
        resolve(value);
      }
    };
    wrapper.stdout?.on("data", observe);
    wrapper.once("error", reject);
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code, signal) => resolve({ code, signal }));
    wrapper.kill("SIGTERM");
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
  await assert.rejects(access(root));
});

test("SIGINT is forwarded unchanged to the owned group before cleanup", async () => {
  let output = "";
  const wrapper = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./run-command.ts", import.meta.url).pathname,
      ...command(["--print-root", "--record-signals", "--wait"]),
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const root = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 20_000);
    const observe = () => {
      const [value] = output.trim().split("\n");
      if (value) {
        clearTimeout(deadline);
        resolve(value);
      }
    };
    wrapper.stdout?.on("data", observe);
    wrapper.once("error", reject);
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code, signal) => resolve({ code, signal }));
  });
  await eventuallyRead(join(root, "signals-ready"));
  wrapper.kill("SIGINT");
  assert.deepEqual(await result, { code: null, signal: "SIGINT" });
  assert.match(output, CHILD_SIGINT_OUTPUT);
  assert.doesNotMatch(output, CHILD_SIGTERM_OUTPUT);
  await assert.rejects(access(root));
});

test("SIGINT waits for the sandbox child group to be published", async () => {
  const runnerTemp = await temporaryParent();
  const wrapper = spawn(process.execPath, ["--import", "tsx", delayedPublishWrapperPath], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp, TEST_SANDBOX_ACTIVE: "", TEST_SANDBOX_DISABLE: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const rootPromise = reportedRoot(wrapper);
  const result = closed(wrapper);
  let settled = false;
  result.then(() => {
    settled = true;
  });
  let commandPgid: number | undefined;
  let groupPath: string | undefined;
  try {
    const root = await rootPromise;
    groupPath = join(root, ".sandbox-child-group");
    commandPgid = Number((await eventuallyRead(`${groupPath}.spawned`, 20_000)).trim());
    assert.ok(Number.isSafeInteger(commandPgid) && commandPgid > 0);
    await eventuallyRead(join(root, "signals-ready"));
    await assert.rejects(access(groupPath));
    wrapper.kill("SIGINT");
    // The launcher must keep waiting for the unpublished group, not give up or clean up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(settled, false);
    await access(root);
    await writeFile(`${groupPath}.release`, "release\n");
    assert.deepEqual(await result, { code: null, signal: "SIGINT" });
    assert.match(output, CHILD_SIGINT_OUTPUT);
    assert.doesNotMatch(output, CHILD_SIGTERM_OUTPUT);
    await eventuallyAbsentGroup(commandPgid);
    await assert.rejects(access(root));
  } finally {
    if (groupPath) {
      await writeFile(`${groupPath}.release`, "release\n").catch(() => {
        // The owner may already have removed its scratch root.
      });
    }
    if (commandPgid) {
      try {
        process.kill(-commandPgid, "SIGKILL");
      } catch {
        // The group may have exited before this failure-path cleanup.
      }
    }
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      wrapper.kill("SIGTERM");
      await result;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("a sandbox that exits before publishing a command group leaves no scratch and propagates its status", async () => {
  const runnerTemp = await temporaryParent();
  const stubs = await temporaryParent();
  try {
    // A bwrap that cannot create namespaces makes TEST_SANDBOX_REQUIRE=1 exit 3 before the command starts.
    await writeFile(join(stubs, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const wrapper = spawn(process.execPath, ["--import", "tsx", wrapperPath, ...command(["--exit=0"])], {
      env: {
        ...process.env,
        PATH: `${stubs}:${process.env.PATH}`,
        PDPP_TEST_SCRATCH_ROOT: undefined,
        PDPP_TEST_SCRATCH_SCHEMA: undefined,
        PDPP_TEST_SCRATCH_MARKER: undefined,
        PDPP_TEST_SCRATCH_NONCE: undefined,
        PDPP_TEST_SCRATCH_OWNER_PID: undefined,
        RUNNER_TEMP: runnerTemp,
        TEST_SANDBOX_ACTIVE: "",
        TEST_SANDBOX_DISABLE: "0",
        TEST_SANDBOX_REQUIRE: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    wrapper.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const started = Date.now();
    assert.deepEqual(await closed(wrapper), { code: 3, signal: null });
    assert.doesNotMatch(stderr, GROUP_STILL_LIVE_OUTPUT);
    assert.ok(Date.now() - started < 3000, "the launcher must not wait out the publish grace period");
    assert.deepEqual(await readdir(join(runnerTemp, "pdpp-test-scratch")), []);
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
    await rm(stubs, { force: true, recursive: true });
  }
});

test("SIGTERM starts bounded escalation before a TERM-ignoring direct child closes", async () => {
  let output = "";
  const wrapper = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./run-command.ts", import.meta.url).pathname,
      ...command(["--print-root", "--ignore-term", "--grandchild", "--grandchild-ignore-term", "--wait"]),
    ],
    { env: { ...process.env, TEST_SANDBOX_DISABLE: "1" }, stdio: ["ignore", "pipe", "ignore"] }
  );
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const root = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 20_000);
    const observe = () => {
      const value = output.trim();
      if (value) {
        clearTimeout(deadline);
        resolve(value);
      }
    };
    wrapper.stdout?.on("data", observe);
    wrapper.once("error", reject);
  });
  const grandchildPid = Number.parseInt(await eventuallyRead(join(root, "grandchild-node.txt")), 10);
  const childPid = Number.parseInt(await eventuallyRead(join(root, "child.txt")), 10);
  const marker = JSON.parse(await readFile(join(root, ".pdpp-test-scratch.json"), "utf8")) as { pgid: number };
  assert.equal(marker.pgid, childPid);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code, signal) => resolve({ code, signal }));
    wrapper.kill("SIGTERM");
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  await assert.rejects(access(root));
});

test("an intentionally detached descendant is outside the process-group containment contract", async () => {
  const runnerTemp = await temporaryParent();
  const wrapper = startWrapper(["--print-root", "--escaped-grandchild", "--wait"], {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    TEST_SANDBOX_DISABLE: "1",
  });
  let escapedPid: number | undefined;
  try {
    const root = await reportedRoot(wrapper);
    escapedPid = Number.parseInt(await eventuallyRead(join(root, "grandchild-escaped.txt")), 10);
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 0);
    const close = closed(wrapper);
    wrapper.kill("SIGTERM");
    assert.deepEqual(await close, { code: null, signal: "SIGTERM" });
    process.kill(escapedPid, 0);
    await assert.rejects(access(root));
  } finally {
    if (escapedPid !== undefined) {
      try {
        process.kill(-escapedPid, "SIGKILL");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      }
      await eventuallyAbsentGroup(escapedPid);
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("a signal latched while the running transition is durable is forwarded after the PGID exists", async () => {
  const result = await runScratchCommand(command(["--ignore-term", "--wait"]), {
    afterSpawnBeforeRunning: async () => {
      process.kill(process.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
});

test("SIGTERM latched before recovery creates no allocation or child", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const result = await runScratchCommand(command(["--print-root"]), {
      afterSignalHandlersInstalled: async () => {
        process.kill(process.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("SIGTERM during allocation cleanup prevents spawn", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const result = await runScratchCommand(command(["--print-root"]), {
      afterAllocationBeforeSpawn: async () => {
        process.kill(process.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("SIGTERM during cleanup remains observable after the root is removed", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const result = await runScratchCommand(command(["--exit=0"]), {
      cleanupHooks: {
        afterJournal: async () => {
          process.kill(process.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      },
    });
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("a latched signal plus a pre-launch error cleans the provably allocated root", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const result = await runScratchCommand(command(["--print-root"]), {
      afterAllocationBeforeSpawn: async () => {
        process.kill(process.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("simulate pre-launch failure");
      },
    });
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("SIGKILL during spawn-before-running retains a launching root even after its group dies", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const proc = startLaunchingWrapper({ ...process.env, RUNNER_TEMP: runnerTemp, TEST_SANDBOX_DISABLE: "1" });
  try {
    const root = await reportedRoot(proc);
    const markerPath = join(root, ".pdpp-test-scratch.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { state: string };
    assert.equal(marker.state, "launching");
    const childPid = Number.parseInt(await eventuallyRead(join(root, "child.txt")), 10);
    const close = exited(proc);
    proc.kill("SIGKILL");
    assert.deepEqual(await close, { code: null, signal: "SIGKILL" });
    const now = Date.now() + 120_000;
    assert.deepEqual(await recoverStaleScratch({ now, parent }), [
      { path: root, reason: "launch-unknown", removed: false },
    ]);
    process.kill(-childPid, "SIGKILL");
    await eventuallyAbsentGroup(childPid);
    assert.deepEqual(await recoverStaleScratch({ now: now + 120_000, parent }), [
      { path: root, reason: "launch-unknown", removed: false },
    ]);
    await access(root);
  } finally {
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("journal recovery resumes an interrupted rename and survives embedded-marker removal", async () => {
  const parent = await temporaryParent();
  const sentinel = join(parent, "sentinel");
  await writeFile(sentinel, "unchanged");
  const beforeRename = await allocateScratchOwnership({ parent });
  const afterRename = await allocateScratchOwnership({ parent });
  try {
    await oldMarker(beforeRename);
    await assert.rejects(
      cleanupScratchOwnership(beforeRename, {
        afterJournal: () => Promise.reject(new Error("simulate crash after journal")),
      })
    );
    await oldMarker(afterRename);
    await assert.rejects(
      cleanupScratchOwnership(afterRename, {
        afterRename: async () => {
          await rm(afterRename.allocation.markerPath);
          throw new Error("simulate crash after rename and marker loss");
        },
      })
    );
    const results = await recoverStaleScratch({ parent });
    assert.ok(results.some((result) => result.reason === "dead-verified" && result.removed));
    await assert.rejects(access(beforeRename.allocation.root));
    await assert.rejects(access(afterRename.allocation.root));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    assert.ok(!(await readdir(parent)).some((entry) => entry.startsWith(".scratch-cleanup-")));
    assert.ok(!(await readdir(parent)).some((entry) => entry.startsWith(".quarantine-")));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("recovery retains a quarantine whose marker was partly removed without a journal", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const quarantine = join(parent, `.quarantine-${ownership.allocation.nonce}`);
  try {
    await oldMarker(ownership);
    await rename(ownership.allocation.root, quarantine);
    await rm(join(quarantine, ".pdpp-test-scratch.json"));
    assert.deepEqual(await recoverStaleScratch({ parent }), [
      { path: quarantine, reason: "quarantine-no-capability", removed: false },
    ]);
    await access(quarantine);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("a malformed nonempty boot identity cannot bypass the live-group proof", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const liveGroup = spawn("sh", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" });
  assert.ok(liveGroup.pid);
  try {
    await oldMarker(ownership, { boot_id: "not-a-lowercase-linux-uuid", pgid: liveGroup.pid, state: "running" });
    assert.deepEqual(await recoverStaleScratch({ parent }), [
      { path: ownership.allocation.root, reason: "malformed-marker", removed: false },
    ]);
    await access(ownership.allocation.root);
    process.kill(-liveGroup.pid, 0);
  } finally {
    process.kill(-liveGroup.pid, "SIGKILL");
    await rm(parent, { force: true, recursive: true });
  }
});

test("recovery budgets bound inventory inspection and still permit the new owner", async () => {
  const runnerTemp = await temporaryParent();
  const parent = join(runnerTemp, "pdpp-test-scratch");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    await mkdir(parent, { mode: 0o700 });
    await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(parent, `foreign-${index}`), "defer")));
    const inspected: string[] = [];
    const recovered = await recoverStaleScratch({
      hooks: { onInspect: (path) => inspected.push(path) },
      limits: { maxInspectedEntries: 3 },
      parent,
    });
    assert.ok(inspected.length <= 3);
    assert.deepEqual(recovered.at(-1), { path: parent, reason: "recovery-budget-exhausted", removed: false });
    assert.deepEqual(await runScratchCommand(command(["--exit=0"]), { recoveryLimits: { maxInspectedEntries: 1 } }), {
      code: 0,
      signal: null,
    });
  } finally {
    if (previousRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previousRunnerTemp;
    }
    await rm(runnerTemp, { force: true, recursive: true });
  }
});

test("a durable lexical cursor eventually reaches a stale candidate beyond an initial recovery page", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const cursor = join(parent, ".scratch-recovery-cursor.json");
  const limits = { maxInspectedEntries: 2, maxRemovalAttempts: 1, maxStateTransitions: 2 };
  try {
    await oldMarker(ownership);
    await Promise.all(Array.from({ length: 5 }, (_, index) => writeFile(join(parent, `entry-0${index}`), "defer")));
    await writeFile(cursor, "{not-json}\n", { mode: 0o600 });

    const firstInspected: string[] = [];
    const first = await recoverStaleScratch({
      hooks: { onInspect: (path) => firstInspected.push(path) },
      limits,
      parent,
    });
    assert.deepEqual(firstInspected, [join(parent, "entry-00"), join(parent, "entry-01")]);
    assert.ok(!firstInspected.includes(ownership.allocation.root));
    assert.deepEqual(first.at(-1), { path: parent, reason: "recovery-budget-exhausted", removed: false });

    const secondInspected: string[] = [];
    const second = await recoverStaleScratch({
      hooks: { onInspect: (path) => secondInspected.push(path) },
      limits,
      parent,
    });
    assert.deepEqual(secondInspected, [join(parent, "entry-02"), join(parent, "entry-03")]);
    assert.deepEqual(second.at(-1), { path: parent, reason: "recovery-budget-exhausted", removed: false });

    const thirdInspected: string[] = [];
    const third = await recoverStaleScratch({
      hooks: { onInspect: (path) => thirdInspected.push(path) },
      limits,
      parent,
    });
    assert.deepEqual(thirdInspected, [join(parent, "entry-04"), ownership.allocation.root]);
    assert.ok(third.some((result) => result.path === ownership.allocation.root && result.removed));
    await assert.rejects(access(ownership.allocation.root));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("recovery fails closed when its cursor cannot be replaced", async () => {
  const parent = await temporaryParent();
  const cursor = join(parent, ".scratch-recovery-cursor.json");
  await mkdir(cursor, { mode: 0o700 });
  const inspected: string[] = [];
  const recovered = await recoverStaleScratch({
    hooks: { onInspect: (path) => inspected.push(path) },
    limits: { maxInspectedEntries: 1 },
    parent,
  });
  assert.deepEqual(inspected, []);
  assert.deepEqual(recovered, [{ path: cursor, reason: "recovery-cursor-write-failed", removed: false }]);
  await rm(parent, { force: true, recursive: true });
});

test("startup recovery quarantines a large verified root when recursive removal is budgeted out", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  const quarantine = join(parent, `.quarantine-${ownership.allocation.nonce}`);
  const transitions: string[] = [];
  const removals: string[] = [];
  try {
    await writeFile(join(ownership.allocation.root, "large"), "x".repeat(1024 * 1024));
    await oldMarker(ownership);
    const recovered = await recoverStaleScratch({
      hooks: {
        onRemovalAttempt: (path) => removals.push(path),
        onStateTransition: (path) => transitions.push(path),
      },
      limits: { maxRemovalAttempts: 0, maxStateTransitions: 2 },
      parent,
    });
    assert.deepEqual(removals, []);
    assert.equal(transitions.length, 2);
    assert.ok(recovered.some((result) => result.reason === "recovery-budget-exhausted"));
    await access(quarantine);
    await access(join(quarantine, "large"));
    await access(join(parent, `.scratch-cleanup-${ownership.allocation.nonce}.json`));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("SIGKILL leaves a live orphan, then a later recovery removes its dead group", async () => {
  const runnerTemp = await temporaryParent();
  const sibling = join(runnerTemp, "sibling-sentinel");
  await writeFile(sibling, "unchanged");
  const proc = startWrapper(["--print-root", "--grandchild", "--grandchild-ignore-term", "--wait"], {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    TEST_SANDBOX_DISABLE: "1",
  });
  const root = await reportedRoot(proc);
  const markerPath = join(root, ".pdpp-test-scratch.json");
  const marker = await eventuallyRunningMarker(markerPath);
  const close = exited(proc);
  proc.kill("SIGKILL");
  assert.deepEqual(await close, { code: null, signal: "SIGKILL" });
  const wrapperPid = proc.pid;
  assert.ok(wrapperPid);
  assert.throws(() => process.kill(wrapperPid, 0), { code: "ESRCH" });
  process.kill(-marker.pgid, 0);
  await writeFile(
    markerPath,
    `${JSON.stringify({ ...marker, created_at: new Date(Date.now() - 120_000).toISOString() })}\n`
  );
  const parent = join(runnerTemp, "pdpp-test-scratch");
  assert.deepEqual(await recoverStaleScratch({ parent }), [{ path: root, reason: "group-live", removed: false }]);
  assert.equal(await readFile(join(root, "child-root.txt"), "utf8"), `${root}\n`);
  assert.equal(await readFile(sibling, "utf8"), "unchanged");
  process.kill(-marker.pgid, "SIGKILL");
  await eventuallyAbsentGroup(marker.pgid);
  await eventuallyRecover(parent, root);
  await assert.rejects(access(root));
  assert.equal(await readFile(sibling, "utf8"), "unchanged");
  await rm(runnerTemp, { force: true, recursive: true });
});

test("recovery has stable fail-closed classifications for every stale candidate state", async () => {
  const parent = await temporaryParent();
  const allocated = await allocateScratchOwnership({ parent });
  const sameBootDead = await allocateScratchOwnership({ parent });
  const priorBoot = await allocateScratchOwnership({ parent });
  const ownerLive = await allocateScratchOwnership({ parent });
  const malformed = join(parent, "run-malformed");
  const unknownState = await allocateScratchOwnership({ parent });
  const wrongMode = await allocateScratchOwnership({ parent });
  const invalidRoot = join(parent, "run-invalid-root");
  const target = join(parent, "target");
  const link = join(parent, "run-link");
  const swapped = await allocateScratchOwnership({ parent });
  const foreign = join(parent, "not-a-scratch-root");
  const fresh = await allocateScratchOwnership({ parent });
  const unverifiableBoot = await allocateScratchOwnership({ parent });
  const bootId = await currentBootId();
  const liveGroup = spawn("sh", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" });
  assert.ok(liveGroup.pid);
  const runningLiveGroup = await allocateScratchOwnership({ parent });
  const priorBootLiveGroup = await allocateScratchOwnership({ parent });
  try {
    await oldMarker(allocated);
    await oldMarker(sameBootDead, { boot_id: bootId, pgid: 999_999_999, state: "running" });
    await oldMarker(priorBoot, { boot_id: differentBootId(bootId), pgid: 999_999_999, state: "running" });
    await oldMarker(ownerLive, { owner_pid: process.pid });
    await mkdir(malformed, { mode: 0o700 });
    await oldMarker(unknownState, { state: "unexpected" });
    await chmod(wrongMode.allocation.root, 0o755);
    await writeFile(invalidRoot, "not a directory");
    await writeFile(target, "not a directory");
    await symlink(target, link);
    await oldMarker(swapped);
    const parked = `${swapped.allocation.root}-parked`;
    await rename(swapped.allocation.root, parked);
    await mkdir(swapped.allocation.root, { mode: 0o700 });
    await writeFile(swapped.allocation.markerPath, await readFile(join(parked, ".pdpp-test-scratch.json")), {
      mode: 0o600,
    });
    await mkdir(foreign, { mode: 0o700 });
    await oldMarker(runningLiveGroup, {
      boot_id: bootId,
      pgid: liveGroup.pid,
      state: "running",
    });
    await oldMarker(priorBootLiveGroup, {
      boot_id: differentBootId(bootId),
      pgid: liveGroup.pid,
      state: "running",
    });
    await oldMarker(unverifiableBoot, { pgid: liveGroup.pid, state: "running" });

    const results = await recoverStaleScratch({ parent });
    const reason = new Map(results.map((result) => [result.path, result.reason]));
    assert.equal(reason.get(allocated.allocation.root), "dead-verified");
    assert.equal(reason.get(sameBootDead.allocation.root), bootId ? "dead-verified" : "unverifiable-boot");
    assert.equal(reason.get(priorBoot.allocation.root), bootId ? "dead-verified" : "unverifiable-boot");
    assert.equal(reason.get(ownerLive.allocation.root), "owner-live");
    assert.equal(reason.get(malformed), "malformed-marker");
    assert.equal(reason.get(unknownState.allocation.root), "malformed-marker");
    assert.equal(reason.get(wrongMode.allocation.root), "wrong-mode");
    assert.equal(reason.get(invalidRoot), "invalid-root");
    assert.equal(reason.get(link), "symlink");
    assert.equal(reason.get(swapped.allocation.root), "identity-mismatch");
    assert.equal(reason.get(foreign), "foreign-entry");
    assert.equal(reason.get(fresh.allocation.root), "fresh");
    assert.equal(reason.get(runningLiveGroup.allocation.root), "group-live");
    assert.equal(reason.get(priorBootLiveGroup.allocation.root), "group-live");
    assert.equal(reason.get(unverifiableBoot.allocation.root), "group-live");
    await assert.rejects(access(allocated.allocation.root));
    if (bootId) {
      await assert.rejects(access(sameBootDead.allocation.root));
      await assert.rejects(access(priorBoot.allocation.root));
    } else {
      await access(sameBootDead.allocation.root);
      await access(priorBoot.allocation.root);
    }
    await access(ownerLive.allocation.root);
    await access(runningLiveGroup.allocation.root);
    await access(priorBootLiveGroup.allocation.root);
    await access(unverifiableBoot.allocation.root);
    process.kill(-liveGroup.pid, 0);
  } finally {
    process.kill(-liveGroup.pid, "SIGKILL");
    await rm(parent, { force: true, recursive: true });
  }
});

test("concurrent recovery removes a verified stale root at most once", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  await oldMarker(ownership);
  try {
    const recovered = await Promise.all([recoverStaleScratch({ parent }), recoverStaleScratch({ parent })]);
    const removals = recovered.flat().filter((result) => result.path === ownership.allocation.root && result.removed);
    assert.equal(removals.length, 1);
    await assert.rejects(access(ownership.allocation.root));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("wrong-owner candidates have a stable conservative recovery reason", async () => {
  const parent = await temporaryParent();
  const ownership = await allocateScratchOwnership({ parent });
  try {
    const rootStats = await lstat(ownership.allocation.root);
    assert.equal(scratchCandidateSafetyReason(rootStats, rootStats.uid + 1), "wrong-owner");
  } finally {
    await cleanupScratchOwnership(ownership);
    await rm(parent, { force: true, recursive: true });
  }
});

test("parallel outer owners isolate participant worker trees under one inherited root each", async () => {
  const runnerTemp = await temporaryParent();
  const env = { ...process.env, RUNNER_TEMP: runnerTemp, TEST_SANDBOX_DISABLE: "1" };
  const first = startWrapper(["--print-root", "--nested-participant", "--wait"], env);
  const second = startWrapper(["--print-root", "--nested-participant", "--wait"], env);
  const [firstRoot, secondRoot] = await Promise.all([reportedRoot(first), reportedRoot(second)]);
  try {
    assert.notEqual(await realpath(firstRoot), await realpath(secondRoot));
    const firstMarker = JSON.parse(await readFile(join(firstRoot, ".pdpp-test-scratch.json"), "utf8")) as {
      nonce: string;
    };
    const secondMarker = JSON.parse(await readFile(join(secondRoot, ".pdpp-test-scratch.json"), "utf8")) as {
      nonce: string;
    };
    assert.notEqual(firstMarker.nonce, secondMarker.nonce);
    for (const root of [firstRoot, secondRoot]) {
      // biome-ignore lint/performance/noAwaitInLoops: each descendant publishes a bounded readiness sentinel.
      assert.equal((await eventuallyRead(join(root, "child-root.txt"))).trim(), root);
      assert.equal((await eventuallyRead(join(root, "participant-root.txt"))).trim(), root);
      for (const name of ["one", "two"]) {
        // biome-ignore lint/performance/noAwaitInLoops: two parallel workers and their leaves publish independently.
        assert.equal((await eventuallyRead(join(root, `worker-${name}-root.txt`))).trim(), root);
        assert.equal((await eventuallyRead(join(root, `grandchild-${name}-leaf-root.txt`))).trim(), root);
      }
      const [firstWorkerPath, secondWorkerPath] = await Promise.all([
        eventuallyRead(join(root, "worker-one-path.txt")),
        eventuallyRead(join(root, "worker-two-path.txt")),
      ]);
      assert.notEqual(firstWorkerPath.trim(), secondWorkerPath.trim());
      const workerPaths = [firstWorkerPath, secondWorkerPath];
      assert.ok(workerPaths.every((path) => path.trim().startsWith(`${root}/worker-`)));
      assert.equal((await readdir(root)).filter((entry) => entry === ".pdpp-test-scratch.json").length, 1);
      await access(join(root, "child.txt"));
    }
  } finally {
    const firstClose = closed(first);
    const secondClose = closed(second);
    first.kill("SIGTERM");
    second.kill("SIGTERM");
    assert.deepEqual(await firstClose, { code: null, signal: "SIGTERM" });
    assert.deepEqual(await secondClose, { code: null, signal: "SIGTERM" });
    await assert.rejects(access(firstRoot));
    await assert.rejects(access(secondRoot));
    await rm(runnerTemp, { force: true, recursive: true });
  }
});
