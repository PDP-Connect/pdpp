// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Scheduler dispatch-liveness deadline (see `dispatchLivenessCeilingMs` /
// `raceDispatchLivenessDeadline` in runtime/scheduler.ts for the mechanism
// and its rationale).
//
// Covers: a permanently-wedged pre-run gate with no ceiling (CONTROL); the
// deadline unwedging it with one typed record per wedge; a late resolution
// of an abandoned gate call producing no extra output; the ceiling's own
// input validation (negative/zero/Infinity); and a COUNTERWEIGHT proving a
// real long-running launched run is never touched by the (much shorter)
// prelaunch ceiling.
//
// Only the COUNTERWEIGHT test reaches a real connector launch; the rest
// stay free of any handle that could outlive `scheduler.stop()`. Every
// scheduler is torn down via `t.after`; every wait is bounded (`waitFor`),
// so a regression fails with a clear timeout instead of hanging the runner.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScheduler, type Scheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

// COUNTERWEIGHT needs a manifest with a stream: runConnector's START
// payload requires at least one, or the run fails immediately.
const REAL_DISPATCH_MANIFEST = {
  capabilities: { refresh_policy: { background_safe: true } },
  streams: [
    {
      name: "items",
      primary_key: "id",
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
};

function fakeAdmitRunConnection() {
  return ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) =>
    Promise.resolve({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? connectorId,
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded poll loop matches this suite's sibling fixtures.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/** A real subprocess connector that logs each START and completes only after `releasePath` exists. */
function writeReleasableConnector(tmpDir: string, name: string) {
  const connectorPath = join(tmpDir, `${name}.mjs`);
  const attemptsPath = join(tmpDir, `${name}.attempts.log`);
  const releasePath = join(tmpDir, `${name}.release`);

  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const releasePath = ${JSON.stringify(releasePath)};
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, Date.now() + '\\n', 'utf8');
  const timer = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
  }, 10);
  timer.unref?.();
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);

  return {
    attemptsPath,
    connectorPath,
    release: () => writeFileSync(releasePath, "release", "utf8"),
  };
}

function readAttemptCount(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

function minimalSchedulerOpts(dispatchLivenessCeilingMs: number) {
  return {
    connectors: [
      {
        connectorId: "dispatch-liveness-validation-connector",
        connectorPath: "/tmp/unreachable-connector-must-never-spawn.mjs",
        intervalMs: 60_000,
        manifest: {},
        ownerToken: "owner-token",
      },
    ],
    dispatchLivenessCeilingMs,
    onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
  };
}

test("createScheduler rejects a negative dispatchLivenessCeilingMs", () => {
  assert.throws(() => createScheduler(minimalSchedulerOpts(-1)), /non-negative/);
});

test("dispatchLivenessCeilingMs: 0 and Infinity both mean disabled, not rejected", () => {
  assert.doesNotThrow(() => createScheduler(minimalSchedulerOpts(0)).stop());
  assert.doesNotThrow(() => createScheduler(minimalSchedulerOpts(Number.POSITIVE_INFINITY)).stop());
});

test(
  "CONTROL: a wedged pre-run gate (hung readinessChecker) permanently suppresses dispatch with NO liveness ceiling",
  { timeout: 5000 },
  async (t) => {
    const completedRuns: RunRecord[] = [];
    let readinessCalls = 0;
    let scheduler: Scheduler | null = null;

    t.after(() => {
      scheduler?.stop();
    });

    scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: "dispatch-wedge-control-connector",
          connectorInstanceId: "dispatch-wedge-control-connector",
          connectorPath: "/tmp/unreachable-connector-must-never-spawn.mjs",
          intervalMs: 25,
          manifest: { capabilities: { refresh_policy: { background_safe: true } } },
          maxRetries: 0,
          ownerToken: "owner-token",
        },
      ],
      dispatchLivenessCeilingMs: Number.POSITIVE_INFINITY, // negative control
      getState: async () => null,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: () => {
        readinessCalls += 1;
        return new Promise(() => undefined);
      },
      rsUrl: "http://localhost.invalid",
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(readinessCalls, 1, "the gate must be entered exactly once, then permanently wedged with no ceiling");
    assert.equal(completedRuns.length, 0, "no record at all is produced -- this is the silent-forever defect");
  }
);

test(
  "dispatch-liveness deadline unwedges a hung pre-run gate, emits exactly one typed failed record, then dispatch resumes",
  { timeout: 5000 },
  async (t) => {
    const completedRuns: RunRecord[] = [];
    let readinessCalls = 0;
    let scheduler: Scheduler | null = null;

    t.after(() => {
      scheduler?.stop();
    });

    scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: "dispatch-wedge-deadline-connector",
          connectorInstanceId: "dispatch-wedge-deadline-connector",
          connectorPath: "/tmp/unreachable-connector-must-never-spawn.mjs",
          intervalMs: 25,
          manifest: { capabilities: { refresh_policy: { background_safe: true } } },
          maxRetries: 0,
          ownerToken: "owner-token",
        },
      ],
      dispatchLivenessCeilingMs: 60,
      getState: async () => null,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: () => {
        readinessCalls += 1;
        return new Promise(() => undefined); // hangs every tick -- each is a fresh wedge
      },
      rsUrl: "http://localhost.invalid",
    });

    scheduler.start();

    await waitFor(
      () => completedRuns.filter((r) => r.terminalReason === "scheduler_dispatch_wedged").length >= 3,
      3000
    );
    scheduler.stop();

    assert.ok(readinessCalls >= 3, "the gate must be re-entered on later ticks, proving dispatch genuinely resumed");
    for (const record of completedRuns) {
      assert.equal(record.terminalReason, "scheduler_dispatch_wedged");
      assert.equal(record.status, "failed", "a wedge is a failure, not a silent skip -- it needs an audit trail");
      assert.equal(
        record.connectorInstanceId,
        "dispatch-wedge-deadline-connector",
        "the record must be scoped to the actual wedged connector instance"
      );
    }
  }
);

test(
  "a late resolution of an abandoned wedged gate call must not produce a second record or a launch",
  { timeout: 5000 },
  async (t) => {
    const completedRuns: RunRecord[] = [];
    let readinessCalls = 0;
    let releaseFirstReadiness: (() => void) | undefined;
    let scheduler: Scheduler | null = null;

    t.after(() => {
      scheduler?.stop();
      releaseFirstReadiness?.();
    });

    scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: "dispatch-late-resolve-connector",
          connectorInstanceId: "dispatch-late-resolve-connector",
          connectorPath: "/tmp/unreachable-connector-must-never-spawn.mjs",
          intervalMs: 25,
          manifest: { capabilities: { refresh_policy: { background_safe: true } } },
          maxRetries: 0,
          ownerToken: "owner-token",
        },
      ],
      dispatchLivenessCeilingMs: 60,
      getState: async () => null,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: () => {
        readinessCalls += 1;
        if (readinessCalls === 1) {
          // Held open past its own deadline, released only at the end --
          // models a probe that resolves long after its caller moved on.
          return new Promise((resolve) => {
            releaseFirstReadiness = () => resolve({ ready: true });
          });
        }
        return new Promise(() => undefined); // later ticks: irrelevant to this test, just don't reach a real dispatch
      },
      rsUrl: "http://localhost.invalid",
    });

    scheduler.start();

    await waitFor(() => completedRuns.some((r) => r.terminalReason === "scheduler_dispatch_wedged"), 3000);
    // Stop immediately: later ticks also hang and would each produce their
    // own wedged record, making the count racy against the tick interval.
    scheduler.stop();
    const wedgedCountAtFirstDeadline = completedRuns.length;

    releaseFirstReadiness?.(); // late resolution of the abandoned first call; scheduler is stopped, nothing else can produce output
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(
      completedRuns.length,
      wedgedCountAtFirstDeadline,
      "the late resolution of an abandoned gate call must not produce ANY additional record"
    );
  }
);

test(
  "COUNTERWEIGHT: a real connector run legitimately exceeding the short prelaunch ceiling is never treated as wedged",
  { timeout: 8000 },
  async (t) => {
    initDb(makeTemporaryDbPath("pdpp-dispatch-launched-survives-"));
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-dispatch-launched-survives-"));
    const connector = writeReleasableConnector(tmpDir, "launched-survives-connector");
    const completedRuns: RunRecord[] = [];
    let scheduler: Scheduler | null = null;

    t.after(() => {
      scheduler?.stop();
      connector.release();
      rmSync(tmpDir, { force: true, recursive: true });
      closeDb();
    });

    scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: "launched-survives-connector",
          connectorInstanceId: "launched-survives-connector",
          connectorPath: connector.connectorPath,
          intervalMs: 25,
          manifest: REAL_DISPATCH_MANIFEST,
          maxRetries: 0,
          ownerToken: "owner-token",
        },
      ],
      dispatchLivenessCeilingMs: 40, // short: the run below legitimately outlives it several times over
      getState: async () => null,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: () => Promise.resolve({ ready: true }),
      rsUrl: "http://localhost.invalid",
    });

    scheduler.start();

    await waitFor(() => readAttemptCount(connector.attemptsPath) >= 1, 3000);
    await new Promise((resolve) => setTimeout(resolve, 400)); // 10x the ceiling

    assert.equal(
      readAttemptCount(connector.attemptsPath),
      1,
      "a real long-running launched connector run must never be double-dispatched by the prelaunch deadline"
    );
    assert.equal(
      completedRuns.filter((r) => r.terminalReason === "scheduler_dispatch_wedged").length,
      0,
      "a legitimately long-running launched run must never be classified as a prelaunch wedge"
    );

    connector.release();
    await waitFor(() => completedRuns.some((r) => r.status === "succeeded"), 3000);
    scheduler.stop();

    assert.equal(readAttemptCount(connector.attemptsPath), 1, "still exactly one launch after completion");
  }
);
