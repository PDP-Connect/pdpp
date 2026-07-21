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

const noopRelease = (): Promise<void> => Promise.resolve();
const noopFinalize = (): Promise<void> => Promise.resolve();

test("withShutdownRelease: registers SIGTERM and SIGINT listeners", () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const dispose = withShutdownRelease(noopRelease);
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
  const sibling = (): void => {
    // intentional no-op sibling listener
  };
  process.on("SIGTERM", sibling);
  try {
    const beforeTerm = process.listenerCount("SIGTERM");
    const dispose = withShutdownRelease(noopRelease);
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
  const d1 = withShutdownRelease(noopRelease);
  const d2 = withShutdownRelease(noopRelease);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 2);
  d1();
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
  d2();
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});

test("withShutdownRelease: finalize callback registers without disturbing listener accounting", () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const dispose = withShutdownRelease(noopRelease, { finalize: noopFinalize });
  try {
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
    assert.equal(process.listenerCount("SIGINT"), beforeInt + 1);
  } finally {
    dispose();
  }
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
});

test("withShutdownRelease: signal handler runs finalize before release in order", async () => {
  // Avoid the real exit by stubbing process.exit. The handler's stable
  // reference comes from `withShutdownRelease`; we extract it as the
  // newest SIGTERM listener registered, call it directly, and confirm
  // ordering. dispose() removes our listener at the end.
  const order: string[] = [];
  const originalExit = process.exit;
  let exitCode: number | undefined;
  (process as { exit: (code?: number) => never }).exit = ((code?: number): never => {
    exitCode = code;
    return undefined as never;
  }) as typeof process.exit;
  try {
    const before = process.listeners("SIGTERM");
    const dispose = withShutdownRelease(
      () => {
        order.push("release");
        return Promise.resolve();
      },
      {
        finalize: () => {
          order.push("finalize");
          return Promise.resolve();
        },
      }
    );
    try {
      const added = process.listeners("SIGTERM").filter((l) => !before.includes(l));
      assert.equal(added.length, 1);
      const handler = added[0] as () => Promise<void>;
      await handler();
      assert.deepEqual(order, ["finalize", "release"]);
      assert.equal(exitCode, 128 + 15);
    } finally {
      dispose();
    }
  } finally {
    (process as { exit: typeof originalExit }).exit = originalExit;
  }
});

test("withShutdownRelease: finalize rejection does not block release()", async () => {
  const order: string[] = [];
  const originalExit = process.exit;
  (process as { exit: (code?: number) => never }).exit = ((_code?: number): never =>
    undefined as never) as typeof process.exit;
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const before = process.listeners("SIGINT");
    const dispose = withShutdownRelease(
      () => {
        order.push("release");
        return Promise.resolve();
      },
      {
        finalize: () => {
          order.push("finalize-throw");
          return Promise.reject(new Error("finalize boom"));
        },
      }
    );
    try {
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      const handler = added[0] as () => Promise<void>;
      await handler();
      // finalize threw but release still ran.
      assert.deepEqual(order, ["finalize-throw", "release"]);
    } finally {
      dispose();
    }
  } finally {
    process.stderr.write = originalWrite;
    (process as { exit: typeof originalExit }).exit = originalExit;
  }
});
