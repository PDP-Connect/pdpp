// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating companion to run-generation-fencing.test.ts scenario (c).
 *
 * That suite's zombie scenario always has `runAlreadyTerminal(staleRunId)`
 * true by the time the zombie's `.catch()` fires (the watchdog's own
 * `run_timed_out` write for the stale run succeeds first), so the fence's
 * own generation-mismatch check at controller.ts's `.catch()` handler is
 * never the thing standing between "fence works" and "fence gutted" there —
 * PROVED by mutation: deleting only the `return;` after the generation
 * check leaves every assertion in that file green (see the commit message
 * for the reproduction and docs/research equivalent gate note).
 *
 * This file closes that gap by forcing the exact condition the fence's own
 * comment cites as its reason to exist (`controller.ts` "Close the
 * phantom-202 window"): the stale run reaches its `.catch()` handler while
 * `runAlreadyTerminal(staleRunId)` is `false` — i.e. the watchdog's own
 * terminal write for the stale run failed (a transient spine-write outage),
 * so ONLY the generation check can prevent the zombie from writing a
 * launch-failure terminal after a newer generation is already active.
 *
 * Mechanism: `emitSpineEvent` is mocked (module-level, real passthrough for
 * every other call) to fail exactly once, for the stale run's own
 * `run_timed_out` watchdog write. That is a real async rejection reaching
 * the same code path production hits on a genuine transient storage error —
 * not a log-string check.
 *
 * Requires `--experimental-test-module-mocks` (Node's supported way to
 * intercept an ESM named export). Self-skips under the default `pnpm test`
 * sweep, matching the established pattern in
 * manual-upload-whatsapp-no-whole-file-read.test.ts. Run directly via:
 *   npm run test:run-generation-fencing-terminal-write-failure
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as realSpine from "../lib/spine.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

// biome-ignore lint/suspicious/noExplicitAny: node:test's MockTracker.module is only present with --experimental-test-module-mocks; the base @types/node signature doesn't expose it unconditionally.
const MODULE_MOCKS_AVAILABLE = typeof (test.mock as any).module === "function";
const SKIP_REASON =
  "requires --experimental-test-module-mocks (npm run test:run-generation-fencing-terminal-write-failure)";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/generation-fence-emit-failure-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Generation Fence Emit-Failure Test",
  streams: [],
  version: "1.0.0",
};
// A wall-clock budget the replacement run cannot reach inside this test —
// same discriminator role as REPLACEMENT_RUN_UNREACHABLE_BUDGET_MS in the
// companion file: any terminal event that lands on it can only be a stale
// write from the superseded predecessor, never its own watchdog.
const REPLACEMENT_RUN_UNREACHABLE_BUDGET_MS = 600_000;

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
    Promise.resolve({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? connectorId,
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    });
}

// Registered once, before any dynamic import of controller.ts, so the
// controller module's own `emitSpineEvent` binding resolves through this
// mock. `emitShouldFailForRunId` is a closure-scoped toggle the test flips
// per-phase rather than a permanent module replacement, so every export
// besides the targeted failure runs the real implementation (real DB
// writes, real terminal-status projection) — this is a targeted fault
// injection, not a fake spine.
let emitShouldFailForRunId: string | null = null;
if (MODULE_MOCKS_AVAILABLE) {
  test.mock.module("../lib/spine.ts", {
    namedExports: {
      ...realSpine,
      emitSpineEvent: (input: realSpine.SpineEventInput, dbHandle?: Parameters<typeof realSpine.emitSpineEvent>[1]) => {
        const data = input?.data as { reason?: unknown } | undefined;
        if (input?.run_id === emitShouldFailForRunId && data?.reason === "run_timed_out") {
          return Promise.reject(new Error("simulated spine write outage"));
        }
        return realSpine.emitSpineEvent(input, dbHandle);
      },
    },
  });
}

test("zombie run is refused when its OWN watchdog terminal write failed (runAlreadyTerminal is false; only the generation check protects the stream)", {
  skip: MODULE_MOCKS_AVAILABLE ? false : SKIP_REASON,
}, async () => {
  const { createController } = await import("../runtime/controller.ts");
  const { closeDb, initDb } = await import("../server/db.ts");
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-gen-fence-emit-failure-"));

  try {
    const rejectFns: ((reason: Error) => void)[] = [];
    const zombieImpl = (): Promise<RuntimeRunConnectorResult> =>
      new Promise((_, reject) => {
        rejectFns.push(reject);
      });

    emitShouldFailForRunId = "run_zombie_emit_fail_1";

    // Short watchdog so run 1 is reclaimed quickly; its watchdog's own
    // run_timed_out write is the one forced to fail above.
    const controller = createController({
      admitRunConnection: fakeAdmitRunConnection(),
      connectorPathResolver: () => "/tmp/connector.js",
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      logger: { error: () => {}, warn: () => {} },
      maxRunWallClockMs: 20,
      runConnectorImpl: zombieImpl,
    });
    // Separate controller instance for run 2, budgeted unreachable, so its
    // own watchdog can never fire — the same split-budget discriminator
    // run-generation-fencing.test.ts scenario (c) uses. Both share the
    // module-scoped activeRuns/runGenerations state.
    const replacementController = createController({
      admitRunConnection: fakeAdmitRunConnection(),
      connectorPathResolver: () => "/tmp/connector.js",
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      logger: { error: () => {}, warn: () => {} },
      maxRunWallClockMs: REPLACEMENT_RUN_UNREACHABLE_BUDGET_MS,
      runConnectorImpl: zombieImpl,
    });

    await controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_gen_fence_emit_fail",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_zombie_emit_fail_1",
    });

    // Let the watchdog fire and its (forced-failing) terminal emit attempt run.
    await new Promise((res) => setTimeout(res, 300).unref());

    // Precondition: the stale run's watchdog write genuinely failed, so
    // runAlreadyTerminal(run_zombie_emit_fail_1) is false. If this ever
    // becomes true, the test below stops discriminating anything — fail
    // loudly rather than silently passing for the wrong reason.
    const staleTerminalBeforeReclaim = await realSpine.getRunTerminalEvent("run_zombie_emit_fail_1");
    assert.equal(
      staleTerminalBeforeReclaim,
      null,
      "precondition failed: the stale run's watchdog terminal write must have failed " +
        "(runAlreadyTerminal must read false) for this test to exercise the generation check in isolation"
    );

    // The reclaim must still succeed (finalizeRunCleanup runs regardless
    // of whether the emit attempt above succeeded).
    const handle2 = await replacementController.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_gen_fence_emit_fail",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_zombie_emit_fail_2",
    });
    assert.equal(handle2.status, "started", "run 2 must be admitted after the reclaim (generation bumps to 2)");

    // Stop forcing failure, then fire the zombie's late rejection. Its
    // `.catch()` handler must refuse the launch-failure terminal purely
    // because generation 2 is active -- runAlreadyTerminal(run 1) is
    // still false at this point, so ONLY the generation check can save it.
    emitShouldFailForRunId = null;
    rejectFns[0]?.(new Error("zombie subprocess late rejection"));
    await new Promise((res) => setTimeout(res, 100).unref());

    const staleTerminalAfterZombieCatch = await realSpine.getRunTerminalEvent("run_zombie_emit_fail_1");
    assert.equal(
      staleTerminalAfterZombieCatch,
      null,
      "the superseded run must NOT acquire a launch-failure terminal after its zombie .catch() fires -- " +
        "runAlreadyTerminal was false, so only the generation-mismatch check can be responsible for this"
    );

    const replacementTerminal = await realSpine.getRunTerminalEvent("run_zombie_emit_fail_2");
    assert.equal(
      replacementTerminal,
      null,
      "the replacement run must have no phantom terminal from the zombie (it is still in flight)"
    );

    rejectFns[1]?.(new Error("replacement run fails normally"));
    await replacementController.drainActiveRuns(1000);
    await controller.drainActiveRuns(1000);
  } finally {
    emitShouldFailForRunId = null;
    closeDb();
  }
});
