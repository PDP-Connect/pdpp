/**
 * shutdown-hook — tests
 *
 * The handler exits the process on real SIGTERM/SIGINT, which we cannot
 * trigger in a unit test without exiting the test runner. Instead, we
 * test the registration/disposal contract: handlers are added to and
 * removed from the process's listener set as documented.
 *
 * Manual integration test (not in CI): in a shell, `node -e "..."` that
 * acquires a release, registers the hook, blocks on `setTimeout`, then
 * `kill -TERM` the process and verify release was called and exit code
 * is 143 (128+15).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withShutdownRelease } from "./shutdown-hook.ts";

test("withShutdownRelease: registers SIGTERM and SIGINT listeners", () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const dispose = withShutdownRelease(async () => {});
  try {
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
    assert.equal(process.listenerCount("SIGINT"), beforeInt + 1);
  } finally {
    dispose();
  }
  // After dispose: counts back to original.
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
});

test("withShutdownRelease: dispose removes only this hook's listeners (not siblings)", () => {
  const sibling = () => {};
  process.on("SIGTERM", sibling);
  try {
    const beforeTerm = process.listenerCount("SIGTERM");
    const dispose = withShutdownRelease(async () => {});
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
    dispose();
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
    // Sibling listener is still there.
    assert.ok(process.listeners("SIGTERM").includes(sibling));
  } finally {
    process.removeListener("SIGTERM", sibling);
  }
});

test("withShutdownRelease: multiple concurrent registrations are independent", () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const d1 = withShutdownRelease(async () => {});
  const d2 = withShutdownRelease(async () => {});
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 2);
  d1();
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
  d2();
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});
