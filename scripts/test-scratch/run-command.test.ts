// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocateScratchOwnership,
  cleanupScratchOwnership,
  recoverStaleScratch,
  scratchCandidateSafetyReason,
} from "./ownership.ts";
import { runScratchCommand } from "./run-command.ts";

const child = new URL("./fixtures/child.ts", import.meta.url).pathname;

function temporaryParent(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdpp-test-scratch-test-"));
}

function command(args: string[]): string[] {
  return ["--", process.execPath, "--import", "tsx", child, ...args];
}

const wrapperPath = new URL("./run-command.ts", import.meta.url).pathname;

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

function reportedRoot(proc: ReturnType<typeof spawn>): Promise<string> {
  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 5000);
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

async function currentBootId(): Promise<string | undefined> {
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (bootId) {
      return bootId;
    }
  } catch {
    // A non-Linux host has no boot identity, so the running-group case remains conservative.
  }
}

async function oldMarker(
  ownership: Awaited<ReturnType<typeof allocateScratchOwnership>>,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const rootStats = await stat(ownership.allocation.root);
  await writeFile(
    ownership.allocation.markerPath,
    `${JSON.stringify({
      created_at: new Date(Date.now() - 120_000).toISOString(),
      dev: rootStats.dev,
      ino: rootStats.ino,
      nonce: ownership.allocation.nonce,
      owner_pid: 999_999_999,
      parent: ownership.allocation.canonicalParent,
      root: ownership.allocation.root,
      schema: "pdpp.test-scratch/v1",
      state: "allocated",
      ...overrides,
    })}\n`
  );
}

async function eventuallyRead(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded fixture readiness polling.
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
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

test("recovery retains fresh and malformed roots", async () => {
  const parent = await temporaryParent();
  const root = join(parent, "run-malformed");
  await mkdir(root, { mode: 0o700 });
  const result = await recoverStaleScratch({ parent });
  assert.deepEqual(result, [{ path: root, reason: "malformed-marker", removed: false }]);
  await rm(parent, { force: true, recursive: true });
});

test("recovery removes only a verified old dead allocation and retains a live owner", async () => {
  const parent = await temporaryParent();
  const stale = await allocateScratchOwnership({ parent });
  const staleStats = await stat(stale.allocation.root);
  await writeFile(
    stale.allocation.markerPath,
    `${JSON.stringify({
      created_at: new Date(Date.now() - 120_000).toISOString(),
      dev: staleStats.dev,
      ino: staleStats.ino,
      nonce: stale.allocation.nonce,
      owner_pid: 999_999_999,
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
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 5000);
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

test("SIGTERM escalates a TERM-ignoring group descendant before cleanup", async () => {
  let output = "";
  const wrapper = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./run-command.ts", import.meta.url).pathname,
      ...command(["--print-root", "--grandchild", "--grandchild-ignore-term", "--wait"]),
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  wrapper.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const root = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("child did not report its scratch root")), 5000);
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
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code, signal) => resolve({ code, signal }));
    wrapper.kill("SIGTERM");
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
  assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  await assert.rejects(access(root));
});

test("SIGKILL leaves a live orphan, then a later recovery removes its dead group", async () => {
  const runnerTemp = await temporaryParent();
  const proc = startWrapper(["--print-root", "--grandchild", "--grandchild-ignore-term", "--wait"], {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
  });
  const root = await reportedRoot(proc);
  const markerPath = join(root, ".pdpp-test-scratch.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pgid: number };
  const close = exited(proc);
  proc.kill("SIGKILL");
  assert.deepEqual(await close, { code: null, signal: "SIGKILL" });
  await writeFile(
    markerPath,
    `${JSON.stringify({ ...marker, created_at: new Date(Date.now() - 120_000).toISOString() })}\n`
  );
  const parent = join(runnerTemp, "pdpp-test-scratch");
  assert.deepEqual(await recoverStaleScratch({ parent }), [{ path: root, reason: "group-live", removed: false }]);
  process.kill(-marker.pgid, "SIGKILL");
  await eventuallyRecover(parent, root);
  await assert.rejects(access(root));
  await rm(runnerTemp, { force: true, recursive: true });
});

test("recovery has stable fail-closed classifications for every stale candidate state", async () => {
  const parent = await temporaryParent();
  const allocated = await allocateScratchOwnership({ parent });
  const priorBoot = await allocateScratchOwnership({ parent });
  const ownerLive = await allocateScratchOwnership({ parent });
  const malformed = join(parent, "run-malformed");
  const wrongMode = await allocateScratchOwnership({ parent });
  const target = join(parent, "target");
  const link = join(parent, "run-link");
  const swapped = await allocateScratchOwnership({ parent });
  const foreign = join(parent, "not-a-scratch-root");
  const bootId = await currentBootId();
  const liveGroup = spawn("sh", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" });
  assert.ok(liveGroup.pid);
  const runningLiveGroup = await allocateScratchOwnership({ parent });
  try {
    await oldMarker(allocated);
    await oldMarker(priorBoot, { boot_id: "prior-boot", pgid: 999_999_999, state: "running" });
    await oldMarker(ownerLive, { owner_pid: process.pid });
    await mkdir(malformed, { mode: 0o700 });
    await chmod(wrongMode.allocation.root, 0o755);
    await writeFile(target, "not a directory");
    await symlink(target, link);
    await oldMarker(swapped);
    const parked = `${swapped.allocation.root}-parked`;
    await rename(swapped.allocation.root, parked);
    await mkdir(swapped.allocation.root, { mode: 0o700 });
    await writeFile(swapped.allocation.markerPath, await readFile(join(parked, ".pdpp-test-scratch.json")));
    await mkdir(foreign, { mode: 0o700 });
    await oldMarker(runningLiveGroup, {
      boot_id: bootId,
      pgid: liveGroup.pid,
      state: "running",
    });

    const results = await recoverStaleScratch({ parent });
    const reason = new Map(results.map((result) => [result.path, result.reason]));
    assert.equal(reason.get(allocated.allocation.root), "dead-verified");
    assert.equal(reason.get(priorBoot.allocation.root), "dead-verified");
    assert.equal(reason.get(ownerLive.allocation.root), "owner-live");
    assert.equal(reason.get(malformed), "malformed-marker");
    assert.equal(reason.get(wrongMode.allocation.root), "wrong-mode");
    assert.equal(reason.get(link), "symlink");
    assert.equal(reason.get(swapped.allocation.root), "identity-mismatch");
    assert.equal(reason.get(foreign), "foreign-entry");
    if (bootId) {
      assert.equal(reason.get(runningLiveGroup.allocation.root), "group-live");
    } else {
      assert.equal(reason.get(runningLiveGroup.allocation.root), "dead-verified");
    }
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

test("parallel outer owners isolate nested, Node, and shell participants in one inherited root each", async () => {
  const runnerTemp = await temporaryParent();
  const env = { ...process.env, RUNNER_TEMP: runnerTemp };
  const first = startWrapper(
    ["--print-root", "--node-grandchild", "--shell-grandchild", "--nested-participant", "--wait"],
    env
  );
  const second = startWrapper(
    ["--print-root", "--node-grandchild", "--shell-grandchild", "--nested-participant", "--wait"],
    env
  );
  const [firstRoot, secondRoot] = await Promise.all([reportedRoot(first), reportedRoot(second)]);
  try {
    assert.notEqual(firstRoot, secondRoot);
    for (const root of [firstRoot, secondRoot]) {
      // biome-ignore lint/performance/noAwaitInLoops: each descendant must publish the exact inherited root.
      assert.equal((await eventuallyRead(join(root, "child-root.txt"))).trim(), root);
      for (const name of ["node", "shell", "nested"]) {
        // biome-ignore lint/performance/noAwaitInLoops: each independent fixture has bounded readiness polling.
        assert.equal((await eventuallyRead(join(root, `grandchild-${name}-root.txt`))).trim(), root);
      }
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
