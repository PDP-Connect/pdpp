// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allocateScratchOwnership, cleanupScratchOwnership, recoverStaleScratch } from "./ownership.ts";
import { runScratchCommand } from "./run-command.ts";

const child = new URL("./fixtures/child.ts", import.meta.url).pathname;

function temporaryParent(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdpp-test-scratch-test-"));
}

function command(args: string[]): string[] {
  return ["--", process.execPath, "--import", "tsx", child, ...args];
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
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
  const result = await recoverStaleScratch({ parent });
  assert.deepEqual(result, [{ path: root, reason: "malformed-marker", removed: false }]);
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
