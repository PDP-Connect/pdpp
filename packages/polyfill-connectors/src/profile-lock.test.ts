// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * profile-lock — tests
 *
 * Covers the SLVP invariants from the module:
 *   1. `removeChromiumSingletonResidue` removes the three Singleton* files
 *      when present, no-ops otherwise, leaves every other path untouched.
 *   2. `withProfileLockMutex` serializes concurrent callers per profileDir
 *      and isolates across different profileDirs.
 *   3. The combination is idempotent and exception-safe.
 *
 * See `profile-lock.ts` header for the design rationale.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeChromiumSingletonResidue, withProfileLockMutex } from "./profile-lock.ts";

function tempProfileDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-profile-lock-"));
}

function writeFakeSingletonFiles(dir: string): void {
  // Use regular files (not symlinks) for the test fixtures — `unlink` works
  // identically. Mirrors how a half-broken Docker volume restore can produce
  // regular files where Chromium expected symlinks.
  fs.writeFileSync(path.join(dir, "SingletonLock"), "fake-host-1234");
  fs.writeFileSync(path.join(dir, "SingletonCookie"), "fake-cookie");
  fs.writeFileSync(path.join(dir, "SingletonSocket"), "fake-socket-ref");
}

test("removeChromiumSingletonResidue: removes all three when present", async () => {
  const dir = tempProfileDir();
  writeFakeSingletonFiles(dir);
  const removed = await removeChromiumSingletonResidue(dir);
  assert.deepEqual(removed.sort(), ["SingletonCookie", "SingletonLock", "SingletonSocket"]);
  assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
  assert.equal(fs.existsSync(path.join(dir, "SingletonCookie")), false);
  assert.equal(fs.existsSync(path.join(dir, "SingletonSocket")), false);
});

test("removeChromiumSingletonResidue: no-op on missing files (ENOENT swallowed)", async () => {
  const dir = tempProfileDir();
  const removed = await removeChromiumSingletonResidue(dir);
  assert.deepEqual(removed, []);
});

test("removeChromiumSingletonResidue: removes only the three named files, leaves siblings untouched", async () => {
  const dir = tempProfileDir();
  writeFakeSingletonFiles(dir);
  // Real Chromium profile state we must never touch:
  fs.writeFileSync(path.join(dir, "Cookies"), "cookie-db-bytes");
  fs.writeFileSync(path.join(dir, "Preferences"), "{}");
  fs.mkdirSync(path.join(dir, "Local Storage"));
  fs.writeFileSync(path.join(dir, "Local Storage", "leveldb"), "leveldb-bytes");
  fs.mkdirSync(path.join(dir, "Default"));
  fs.writeFileSync(path.join(dir, "Default", "Login Data"), "login-data");

  await removeChromiumSingletonResidue(dir);

  // Singleton trio gone:
  assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
  assert.equal(fs.existsSync(path.join(dir, "SingletonCookie")), false);
  assert.equal(fs.existsSync(path.join(dir, "SingletonSocket")), false);
  // Everything else preserved:
  assert.equal(fs.existsSync(path.join(dir, "Cookies")), true);
  assert.equal(fs.existsSync(path.join(dir, "Preferences")), true);
  assert.equal(fs.existsSync(path.join(dir, "Local Storage", "leveldb")), true);
  assert.equal(fs.existsSync(path.join(dir, "Default", "Login Data")), true);
});

test("removeChromiumSingletonResidue: handles symlink targets without following them", async () => {
  const dir = tempProfileDir();
  // Build a target that does not exist — this is the canonical Chromium
  // SingletonLock shape (`<hostname>-<pid>` target string, often dangling).
  const lockPath = path.join(dir, "SingletonLock");
  fs.symlinkSync("dc2b64060bfa-12345", lockPath);
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
  const removed = await removeChromiumSingletonResidue(dir);
  assert.deepEqual(removed, ["SingletonLock"]);
  assert.equal(fs.existsSync(lockPath), false);
});

test("removeChromiumSingletonResidue: is idempotent (re-run after clean is no-op)", async () => {
  const dir = tempProfileDir();
  writeFakeSingletonFiles(dir);
  await removeChromiumSingletonResidue(dir);
  // Re-run.
  const removed = await removeChromiumSingletonResidue(dir);
  assert.deepEqual(removed, []);
});

test("withProfileLockMutex: serializes concurrent callers against the same profile", async () => {
  const dir = tempProfileDir();
  const log: string[] = [];
  // Two callers enter "at the same time"; the mutex must order them.
  const work = (label: string, ms: number) =>
    withProfileLockMutex(dir, async () => {
      log.push(`${label}-enter`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}-exit`);
    });
  await Promise.all([work("A", 30), work("B", 10)]);
  // A must finish before B starts (the mutex guarantees no interleave).
  assert.deepEqual(log, ["A-enter", "A-exit", "B-enter", "B-exit"]);
});

test("withProfileLockMutex: different profileDirs run concurrently", async () => {
  const dirA = tempProfileDir();
  const dirB = tempProfileDir();
  const log: string[] = [];
  const work = (dir: string, label: string, ms: number) =>
    withProfileLockMutex(dir, async () => {
      log.push(`${label}-enter`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}-exit`);
    });
  await Promise.all([work(dirA, "A", 30), work(dirB, "B", 10)]);
  // B (different dir) must complete before A — they were not serialized.
  assert.deepEqual(log, ["A-enter", "B-enter", "B-exit", "A-exit"]);
});

test("withProfileLockMutex: a throwing critical section does not poison the queue", async () => {
  const dir = tempProfileDir();
  const log: string[] = [];
  await assert.rejects(
    () =>
      withProfileLockMutex(dir, () => {
        log.push("first-enter");
        throw new Error("boom");
      }),
    /boom/
  );
  // Subsequent call still runs cleanly.
  await withProfileLockMutex(dir, () => {
    log.push("second-enter");
  });
  assert.deepEqual(log, ["first-enter", "second-enter"]);
});
