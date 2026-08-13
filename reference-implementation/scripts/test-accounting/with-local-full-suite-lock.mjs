// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCK_NAME = "pdpp-test-accounting.lock.d";
const OWNER_NAME = "owner.json";
const INCOMPLETE_OWNER_GRACE_MS = 10_000;
const POLL_INTERVAL_MS = 250;
const WAIT_MESSAGE = "Another full PDPP test-accounting run is active; waiting for it to finish.";

function usage() {
  process.stderr.write("usage: with-local-full-suite-lock.mjs COMMAND [ARG ...]\n");
  process.exit(64);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function gitCommonDirectory() {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function readOwner(ownerPath) {
  try {
    const value = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.wrapper_pid)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner) {
  return pidIsAlive(owner.wrapper_pid) || pidIsAlive(owner.child_pid);
}

function reclaimAbandonedLock(lockPath, ownerPath) {
  const owner = readOwner(ownerPath);
  if (owner && ownerIsAlive(owner)) {
    return false;
  }
  if (!owner) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < INCOMPLETE_OWNER_GRACE_MS) {
        return false;
      }
    } catch {
      return true;
    }
  }

  const abandonedPath = `${lockPath}.abandoned-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, abandonedPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    return false;
  }
  rmSync(abandonedPath, { force: true, recursive: true });
  return true;
}

async function acquireLock() {
  const lockPath = resolve(gitCommonDirectory(), LOCK_NAME);
  const ownerPath = resolve(lockPath, OWNER_NAME);
  const token = randomUUID();
  let announcedWait = false;

  for (;;) {
    try {
      mkdirSync(lockPath);
      const owner = {
        token,
        wrapper_pid: process.pid,
        child_pid: null,
        acquired_at: new Date().toISOString(),
      };
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
      return {
        setChildPid(childPid) {
          owner.child_pid = childPid;
          writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
        },
        release() {
          if (readOwner(ownerPath)?.token === token) {
            rmSync(lockPath, { force: true, recursive: true });
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (reclaimAbandonedLock(lockPath, ownerPath)) {
        continue;
      }
      if (!announcedWait) {
        process.stderr.write(`${WAIT_MESSAGE}\n`);
        announcedWait = true;
      }
      // biome-ignore lint/performance/noAwaitInLoops: acquiring one machine-local lease requires bounded polling of its atomic directory.
      await delay(POLL_INTERVAL_MS);
    }
  }
}

async function runCommand(commandToRun, commandArgs, acquiredLock) {
  const child = spawn(commandToRun, commandArgs, { stdio: "inherit" });
  acquiredLock?.setChildPid(child.pid ?? null);

  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const result = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
  return result;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  usage();
}

let lock;
try {
  if (!process.env.CI) {
    lock = await acquireLock();
  }
  const { code, signal } = await runCommand(command, args, lock);
  lock?.release();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
} catch (error) {
  lock?.release();
  throw error;
}
