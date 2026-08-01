// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mutation-grade regression for the terminal revalidation-anchor await
// (gate-stale-owner-v3-cbe4-0801.md P1): both `run-executor.ts` terminal
// funnels (`finalizeSuccessOrFailure`, `finalizeExhaustedFailure`) MUST
// await `settleRevalidationProbeAnchor` WITHOUT swallowing its rejection,
// so a durable-store failure fails the run's terminal completion closed
// rather than letting the caller observe a false-clean result while the
// anchor is left stale/unsettled.
//
// These tests call `createRunExecutor(...).launchRun(...)` DIRECTLY — not
// through `createScheduler`'s tick loop, which swallows `executeRun`
// rejections by design (`scheduler.ts`'s `executeRun(...).catch(() => {})`)
// and would hide exactly the defect this suite exists to catch. Each test
// asserts on the PROMISE returned by `launchRun` itself: if the await (or
// the settle-anchor call entirely) were removed, `launchRun` would resolve
// normally despite the injected store rejecting/never being called — these
// tests fail deterministically in that case, without polling, a later
// tick, or a test-local evidence flag.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import {
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
} from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule, RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";

function freshDb(t: TestContext): void {
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-anchor-await-db-")), "pdpp.sqlite"));
  t.after(() => closeDb());
}

const CONNECTOR_ID = "revalidation-anchor-await-connector";
const CONNECTOR_INSTANCE_ID = "revalidation-anchor-await-connector";
const INJECTED_STORE_ERROR_RE = /durable store unreachable \(injected\)/;

function buildRuntime(): RunExecutorRuntimeState {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    exhaustedGrants: new Set(),
    history: [],
    running: true,
  };
}

function dispatchableManifest(): Record<string, unknown> {
  return {
    connector_id: CONNECTOR_ID,
    display_name: "Revalidation Anchor Await Test Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

function writeConnectorScript(tmpDir: string, outcome: "succeed" | "fail"): string {
  const path = join(tmpDir, "connector.mjs");
  const donePayload =
    outcome === "succeed"
      ? { records_emitted: 0, status: "succeeded", type: "DONE" }
      : {
          error: { message: "session_required: still not authenticated" },
          records_emitted: 0,
          status: "failed",
          type: "DONE",
        };
  const exitCode = outcome === "succeed" ? 0 : 1;
  writeFileSync(
    path,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'START') return;
  process.stdout.write(${JSON.stringify(JSON.stringify(donePayload))} + '\\n');
  process.exit(${exitCode});
});
`,
    "utf8"
  );
  return path;
}

function buildSchedule(connectorPath: string, maxRetries = 0): ConnectorSchedule {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath,
    intervalMs: 60_000,
    manifest: dispatchableManifest(),
    maxRetries,
    ownerToken: "owner-token",
  };
}

function revalidationAutomationPolicy(): ReturnType<typeof projectRunAutomationPolicy> {
  return projectRunAutomationPolicy({ triggerKind: "revalidation" });
}

interface HarnessOptions {
  readonly settleRevalidationProbeAnchor: RunExecutorDeps["settleRevalidationProbeAnchor"];
}

function buildExecutor(opts: HarnessOptions) {
  const runtime = buildRuntime();
  const completedRuns: RunRecord[] = [];
  const deps: RunExecutorDeps = {
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // no-op
    },
    isManagedConnector: () => false,
    markNeedsHuman: () => {
      // no-op
    },
    maxRunWallClockMs: 5000,
    onInteraction: () => ({ request_id: "unused", status: "cancelled", type: "INTERACTION_RESPONSE" }),
    onRunComplete: (record) => {
      completedRuns.push(record);
    },
    persistLastRunTime: () => {
      // no-op
    },
    recordAndNotify: (record) => {
      runtime.history.push(record);
      return record;
    },
    referenceBaseUrl: null,
    registerRunCancellation: undefined,
    resolveStaticSecretRunEnv: null,
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: null,
    runtime,
    schedulerStore: undefined,
    setState: async () => {
      // no-op
    },
    settleRevalidationProbeAnchor: opts.settleRevalidationProbeAnchor,
  };
  return { completedRuns, executor: createRunExecutor(deps), runtime };
}

test("finalizeSuccessOrFailure: a rejecting settleRevalidationProbeAnchor makes launchRun reject, not resolve with a success record — and no external notification precedes settlement", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-anchor-await-success-reject-"));
  const connectorPath = writeConnectorScript(tmpDir, "succeed");
  let settleCalls = 0;
  const { executor, completedRuns } = buildExecutor({
    settleRevalidationProbeAnchor: (record) => {
      settleCalls += 1;
      assert.equal(record.status, "succeeded", "the settle call must see the real succeeded record");
      // Terminal publication (onRunComplete) must not have fired yet:
      // settlement is ordered STRICTLY BEFORE notification, so no external
      // consumer can ever observe a terminal record whose durable anchor
      // transition has not landed.
      assert.equal(completedRuns.length, 0, "onRunComplete must not have been called before settlement runs");
      return Promise.reject(new Error("durable store unreachable (injected)"));
    },
  });

  await assert.rejects(
    () => executor.launchRun(buildSchedule(connectorPath), false, revalidationAutomationPolicy()),
    INJECTED_STORE_ERROR_RE,
    "launchRun must reject when the anchor settlement fails — a caller (controller.runNow/awaitRun-equivalent) must never observe normal completion while the durable anchor transition failed"
  );
  assert.equal(settleCalls, 1, "settleRevalidationProbeAnchor must have been invoked exactly once");
  // A rejected settlement must NEVER let the run reach the external
  // notification hook at all — proves publication genuinely gates on
  // settlement succeeding, not merely on settlement being awaited.
  assert.equal(
    completedRuns.length,
    0,
    "onRunComplete must never observe a terminal record whose anchor settlement failed"
  );
});

test("finalizeSuccessOrFailure: a rejecting settleRevalidationProbeAnchor makes launchRun reject on a FAILED probe too", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-anchor-await-failure-reject-"));
  const connectorPath = writeConnectorScript(tmpDir, "fail");
  let settleCalls = 0;
  const { executor } = buildExecutor({
    settleRevalidationProbeAnchor: (record) => {
      settleCalls += 1;
      assert.equal(record.status, "failed");
      return Promise.reject(new Error("durable store unreachable (injected)"));
    },
  });

  await assert.rejects(
    () => executor.launchRun(buildSchedule(connectorPath), false, revalidationAutomationPolicy()),
    INJECTED_STORE_ERROR_RE,
    "launchRun must reject for a failed probe too when anchor settlement fails"
  );
  assert.equal(settleCalls, 1);
});

test("finalizeExhaustedFailure: a rejecting settleRevalidationProbeAnchor makes launchRun reject after retries are exhausted", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-anchor-await-exhausted-reject-"));
  const connectorPath = writeConnectorScript(tmpDir, "fail");
  let settleCalls = 0;
  const { executor } = buildExecutor({
    settleRevalidationProbeAnchor: (record) => {
      settleCalls += 1;
      assert.equal(record.status, "failed");
      return Promise.reject(new Error("durable store unreachable (injected)"));
    },
  });

  // maxRetries: 1 with a deterministically-failing connector drives the
  // retry loop to exhaustion and through `finalizeExhaustedFailure` — the
  // SECOND terminal funnel, distinct from `finalizeSuccessOrFailure`.
  await assert.rejects(
    () => executor.launchRun(buildSchedule(connectorPath, 1), false, revalidationAutomationPolicy()),
    INJECTED_STORE_ERROR_RE,
    "launchRun must reject when finalizeExhaustedFailure's anchor settlement fails"
  );
  assert.equal(
    settleCalls,
    1,
    "settleRevalidationProbeAnchor must be called exactly once from the exhausted-failure path"
  );
});

test("mutation guard: a resolving settleRevalidationProbeAnchor lets launchRun resolve normally (proves the harness itself is not broken)", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-anchor-await-baseline-"));
  const connectorPath = writeConnectorScript(tmpDir, "succeed");
  let settleCalls = 0;
  const { executor } = buildExecutor({
    settleRevalidationProbeAnchor: () => {
      settleCalls += 1;
      return Promise.resolve();
    },
  });

  const record = await executor.launchRun(buildSchedule(connectorPath), false, revalidationAutomationPolicy());
  assert.equal(record.status, "succeeded");
  assert.equal(settleCalls, 1);
});

test("ordering: settleRevalidationProbeAnchor precedes runtime.history append, schedulerStore.appendRunHistory, AND onRunComplete — on both terminal funnels", async (t) => {
  freshDb(t);
  const callOrder: string[] = [];

  async function assertOrderedRun(outcome: "succeed" | "fail"): Promise<void> {
    const tmpDir = mkdtempSync(join(tmpdir(), `pdpp-anchor-order-${outcome}-`));
    const connectorPath = writeConnectorScript(tmpDir, outcome);
    const runtimeBase = buildRuntime();
    // A Proxy on `runtime.history` observes `push` calls (the SYNCHRONOUS,
    // instant in-process-visibility side effect) without needing to
    // reimplement the array — `runtime.history.push(record)` in
    // run-executor.ts calls straight through.
    const historyArray: RunRecord[] = [];
    const instrumentedHistory = new Proxy(historyArray, {
      get(target, prop, receiver) {
        if (prop === "push") {
          return (...items: RunRecord[]) => {
            for (const item of items) {
              callOrder.push(`historyPush:${outcome}:${item.status}`);
            }
            return Array.prototype.push.apply(target, items);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const runtime: RunExecutorRuntimeState = { ...runtimeBase, history: instrumentedHistory };
    const completedRuns: RunRecord[] = [];
    const deps: RunExecutorDeps = {
      admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
        Promise.resolve({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        }),
      getState: async () => null,
      handleGrantFailureDisable: () => {
        // no-op
      },
      isManagedConnector: () => false,
      markNeedsHuman: () => {
        // no-op
      },
      maxRunWallClockMs: 5000,
      onInteraction: () => ({ request_id: "unused", status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => {
        callOrder.push(`onRunComplete:${outcome}:${record.status}`);
        completedRuns.push(record);
      },
      persistLastRunTime: () => {
        // no-op
      },
      recordAndNotify: (record) => {
        runtime.history.push(record);
        return record;
      },
      referenceBaseUrl: null,
      registerRunCancellation: undefined,
      resolveStaticSecretRunEnv: null,
      rsUrl: "http://localhost.invalid",
      runManagedConnectorViaController: null,
      runtime,
      // A real `appendRunHistory` (not fire-and-forget-ignored) so the
      // ORDER at which it is invoked is observable — the point under test
      // is invocation order, not persistence; SQLite's own `exec()` is
      // synchronous, which is exactly why an out-of-order append would be
      // durably externally-observable before settlement even without
      // awaiting this call.
      schedulerStore: {
        appendRunHistory: (record) => {
          callOrder.push(`appendRunHistory:${outcome}:${record.status}`);
        },
        deleteActiveRun: () => {
          // no-op
        },
        upsertActiveRun: () => true,
      },
      setState: async () => {
        // no-op
      },
      settleRevalidationProbeAnchor: (record) => {
        callOrder.push(`settle:${outcome}:${record.status}`);
        return Promise.resolve();
      },
    };
    const executor = createRunExecutor(deps);
    await executor.launchRun(
      buildSchedule(connectorPath, outcome === "fail" ? 0 : 0),
      false,
      revalidationAutomationPolicy()
    );
    assert.equal(completedRuns.length, 1, `fixture premise: exactly one terminal record for the ${outcome} run`);
  }

  await assertOrderedRun("succeed");
  await assertOrderedRun("fail");

  assert.deepEqual(
    callOrder,
    [
      "settle:succeed:succeeded",
      "historyPush:succeed:succeeded",
      "appendRunHistory:succeed:succeeded",
      "onRunComplete:succeed:succeeded",
      "settle:fail:failed",
      "historyPush:fail:failed",
      "appendRunHistory:fail:failed",
      "onRunComplete:fail:failed",
    ],
    "settleRevalidationProbeAnchor must precede EVERY terminal publication step (in-process history, durable history append, external notification) on both terminal funnels — mutation-grade: reordering any of these, or dropping any await, changes this exact sequence"
  );
});

test("immediate restart-visible state: the settled anchor is observable synchronously off the SAME store the moment launchRun resolves, no polling", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-anchor-await-immediate-"));
  const connectorPath = writeConnectorScript(tmpDir, "fail");
  // A minimal in-memory "durable" anchor map standing in for the real
  // store — the point under test is ordering (settled BEFORE launchRun
  // resolves), not the real persistence backend (covered separately by
  // synthesized-revalidation-state-durability.test.ts).
  const anchors = new Map<string, { attempt: number }>();
  const { executor } = buildExecutor({
    settleRevalidationProbeAnchor: (record) => {
      if (record.status !== "failed") {
        return Promise.resolve();
      }
      const id = record.connectorInstanceId || record.connectorId;
      const existing = anchors.get(id);
      anchors.set(id, { attempt: (existing?.attempt ?? 0) + 1 });
      return Promise.resolve();
    },
  });

  assert.equal(anchors.has(CONNECTOR_INSTANCE_ID), false, "fixture premise: no anchor before the run");
  await executor.launchRun(buildSchedule(connectorPath), false, revalidationAutomationPolicy());
  // No await, no setTimeout, no waitFor — read the "store" the instant
  // launchRun's promise settles. If the await were removed (or if
  // settleRevalidationProbeAnchor were fire-and-forgotten again), this
  // would be flaky-at-best/absent-at-worst rather than deterministically
  // present.
  const anchor = anchors.get(CONNECTOR_INSTANCE_ID);
  assert.ok(anchor, "the anchor must be durably set the instant launchRun resolves — not eventually, not after a poll");
  assert.equal(anchor.attempt, 1);
});
