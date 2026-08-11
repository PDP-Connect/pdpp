// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const wrapper = resolve("scripts/test-accounting/with-local-full-suite-lock.sh");
const fixtureIdentity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test"];
const WAIT_MESSAGE_PATTERN = /waiting for it to finish/;

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveExit, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child ${child.pid ?? "unknown"} to exit`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolveExit({ code, stderr });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function isRunning(child: ChildProcess | undefined): child is ChildProcess {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling observes a child-process readiness marker without a timing race.
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

test("local full-suite lock spans linked worktrees, releases on exit, and CI bypasses it", async () => {
  const fixtureRoot = mkdtempSync(join(homedir(), ".tmp/pdpp-test-lock-"));
  const repository = join(fixtureRoot, "repository");
  const worktree = join(fixtureRoot, "worktree");
  const ready = join(fixtureRoot, "ready");
  const release = join(fixtureRoot, "release");
  const waited = join(fixtureRoot, "waited");
  const bypassed = join(fixtureRoot, "bypassed");
  const afterExit = join(fixtureRoot, "after-exit");
  mkdirSync(repository);
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", [...fixtureIdentity, "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: repository });
  execFileSync("git", ["worktree", "add", "--quiet", "-b", "fixture-worktree", worktree], { cwd: repository });
  const { CI: _ignoredCi, ...localEnv } = process.env;
  let holder: ChildProcess | undefined;
  let waiter: ChildProcess | undefined;
  let bypass: ChildProcess | undefined;
  let next: ChildProcess | undefined;

  const holderDriver = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(release)})) {
        clearInterval(timer);
      }
    }, 20);
  `;
  const writeDriver = (path: string) => `require("node:fs").writeFileSync(${JSON.stringify(path)}, "done")`;

  try {
    holder = spawn("bash", [wrapper, process.execPath, "-e", holderDriver], {
      cwd: repository,
      env: localEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitForPath(ready);

    waiter = spawn("bash", [wrapper, process.execPath, "-e", writeDriver(waited)], {
      cwd: worktree,
      env: localEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    bypass = spawn("bash", [wrapper, process.execPath, "-e", writeDriver(bypassed)], {
      cwd: worktree,
      env: { ...localEnv, CI: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal((await waitForExit(bypass)).code, 0);
    assert.ok(existsSync(bypassed), "CI must not wait on a workstation-local lock");
    assert.ok(!existsSync(waited), "a linked local worktree must wait while the shared lock is held");

    writeFileSync(release, "release");
    assert.equal((await waitForExit(holder)).code, 0);
    const waitedResult = await waitForExit(waiter);
    assert.equal(waitedResult.code, 0);
    assert.match(waitedResult.stderr, WAIT_MESSAGE_PATTERN);
    assert.ok(existsSync(waited));

    next = spawn("bash", [wrapper, process.execPath, "-e", writeDriver(afterExit)], {
      cwd: repository,
      env: localEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal((await waitForExit(next)).code, 0);
    assert.ok(existsSync(afterExit), "the lock must be released when its command exits");
  } finally {
    writeFileSync(release, "release");
    const children = [holder, waiter, bypass, next].filter(isRunning);
    for (const child of children) {
      child.kill("SIGTERM");
    }
    await Promise.all(
      children.map(async (child) => {
        try {
          await waitForExit(child, 1000);
        } catch {
          child.kill("SIGKILL");
          await waitForExit(child, 1000).catch(() => undefined);
        }
      })
    );
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
