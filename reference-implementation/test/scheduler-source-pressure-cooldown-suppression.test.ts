// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Scheduler cross-run source-pressure cooldown tests for
// `add-schedule-source-pressure-cooldown`.
//
// These drive the runtime/scheduler.ts seam directly (no AS/RS/device-auth)
// so they isolate the cooldown governor from the rest of the reference
// implementation. They prove:
//
//   1. A scheduled connection carrying pending upstream_pressure detail gaps
//      is deferred (not immediately due) and the audit log records exactly one
//      cooling-off skip per pressure identity (no per-tick storm).
//   2. The cooldown window grows / re-arms as the pressure picture changes.
//   3. A recovered run (pending pressure set becomes empty) clears the
//      cooldown — the connection is never stuck cooling forever.
//   4. A no-pressure peer connection is NOT throttled by this policy (no
//      cross-connection bleed).
//   5. A failure inside the durable source-pressure probe must NOT silently
//      suppress launches (fail-open, same stance as the attention probe).
//
// The cooldown is a *cross-run* governor: it defers the next automatic
// dispatch relative to the connection's last-run anchor. We inject a minimal
// `schedulerStore` whose `listLastRunTimes()` seeds a recent anchor so the
// cooldown evaluates on the first tick without needing a live RS/db spawn. A
// not-background-safe manifest means any *eligible* tick emits a deterministic
// automation_policy_blocked skip instead of spawning, so eligibility vs.
// cooldown is observable purely from the skip records.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import type { PendingPressureGap } from "../runtime/scheduler-source-pressure-cooldown.ts";

const REGEXP_1 = /pending source-pressure gap/;
const REGEXP_2 = /source_pressure_cooldown_applied/;
const REGEXP_3 = /automation_policy_blocked/;
const REGEXP_4 = /source_pressure_cooldown_applied/;

interface EscalationInteraction {
  request_id?: string;
}

function unimplemented(name: string): never {
  throw new Error(`test fake: ${name} is not implemented — this path should be unreachable in this test`);
}

// A real connector path is required so the scheduler can build a spawn command,
// but with the policy-blocked manifest below it is never actually spawned. The
// attempts log lets us assert "no spawn happened".
function writeUnusedConnector(tmpDir: string, name = "unused-connector.mjs") {
  const attemptsPath = join(tmpDir, `${name}.attempts.log`);
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
  appendFileSync(${JSON.stringify(attemptsPath)}, 'spawn\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  process.exit(0);
});
`,
    "utf8"
  );
  return { attemptsPath, connectorPath };
}

// Not-background-safe: an eligible automatic tick emits an
// automation_policy_blocked skip BEFORE spawning. So a connection that is
// cooling emits a cooldown skip; a connection that is eligible emits a policy
// skip. Neither spawns the connector.
const POLICY_BLOCKED_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: false },
  },
};

// Seed a recent last-run anchor so the cross-run cooldown evaluates on tick 1.
// `connector_instance_id` defaults to the connector id (runtimeKey fallback).
function anchorStore(anchors: { connectorId: string; lastRunTimeMs: number }[]) {
  return {
    appendRunHistory: () => {
      /* intentionally empty */
    },
    deleteActiveRun: () => unimplemented("deleteActiveRun"),
    listLastRunTimes: () =>
      anchors.map(({ connectorId, lastRunTimeMs }) => ({
        connector_id: connectorId,
        connector_instance_id: connectorId,
        last_run_time_ms: lastRunTimeMs,
        updated_at: new Date(lastRunTimeMs).toISOString(),
      })),
    listRunHistory: () => [],
    upsertActiveRun: () => unimplemented("upsertActiveRun"),
    upsertLastRunTime: () => {
      /* intentionally empty */
    },
  };
}

function pressureGap(overrides: Partial<PendingPressureGap> = {}): PendingPressureGap {
  const {
    reason = "upstream_pressure",
    attemptCount = 0,
    nextAttemptAfter = null,
    lastPressureAt = new Date().toISOString(),
  } = overrides;
  return { attemptCount, lastPressureAt, nextAttemptAfter, reason };
}

function readAttempts(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function cooldownSkips(records: RunRecord[]) {
  return records.filter((r) => REGEXP_4.test(r.error || ""));
}

function policySkips(records: RunRecord[]) {
  return records.filter((r) => REGEXP_3.test(r.error || ""));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for scheduler condition");
}

function cancelledInteractionResponse(...args: unknown[]) {
  const interaction = args[0] as EscalationInteraction;
  return {
    request_id: interaction.request_id,
    status: "cancelled",
    type: "INTERACTION_RESPONSE",
  };
}

test("a connection with pending upstream_pressure gaps cools off — one skip per identity, no spawn", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-"));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-cooldown-connector";

  // High attempt count + recent anchor -> cooldown window (2^6 * 50ms = 3.2s)
  // far exceeds elapsed, so every tick during the test stays deferred.
  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 6 })],
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() }]),
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    // Let many ticks fire to prove the skip is deduped per identity.
    await new Promise((resolve) => setTimeout(resolve, 400));
    scheduler.stop();

    const skips = cooldownSkips(completedRuns);
    assert.equal(skips.length, 1, "exactly one cooling-off skip per pressure identity (deduped across ticks)");
    const [skip] = skips;
    assert.ok(skip, "a cooldown skip record was captured");
    assert.ok(skip.error, "the skip record carries an error message");
    assert.match(skip.error, REGEXP_2);
    assert.match(skip.error, REGEXP_1);
    // Cooldown defers BEFORE the automation-policy gate, so no policy skip and
    // no spawn while cooling.
    assert.equal(policySkips(completedRuns).length, 0, "cooldown defers before the eligibility/policy gate");
    assert.equal(readAttempts(attemptsPath).length, 0, "connector never spawned while cooling off");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("pending pressure gaps do not defer once the computed nextRunAt has arrived", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-due-"));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, "due.mjs");
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-cooldown-due-connector";

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => [
      pressureGap({ attemptCount: 1, lastPressureAt: new Date(Date.now() - 500).toISOString() }),
    ],
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    // attemptCount 1 -> 2x interval (100ms). The last-run anchor is already
    // older than that, so this tick is eligible despite pending pressure gaps.
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 500 }]),
  });

  try {
    scheduler.start();
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.equal(cooldownSkips(completedRuns).length, 0, "due pressure cooldown must not emit a skip");
    assert.ok(policySkips(completedRuns).length >= 1, "due pressure cooldown falls through to eligibility/policy gate");
    assert.equal(readAttempts(attemptsPath).length, 0, "policy-blocked manifest never spawns the connector");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler skip history does not slide source-pressure cooldown forward", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-no-slide-"));
  const { connectorPath } = writeUnusedConnector(tmpDir, "no-slide.mjs");
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-cooldown-no-slide-connector";

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => [
      pressureGap({ attemptCount: 0, lastPressureAt: new Date(Date.now() - 5000).toISOString() }),
    ],
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    // Simulates a restart after a recent cooldown skip was written. The
    // pressure itself was observed long enough ago that retry is due now.
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() }]),
  });

  try {
    scheduler.start();
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.equal(cooldownSkips(completedRuns).length, 0, "skip history must not create a fresh cooldown window");
    assert.ok(policySkips(completedRuns).length >= 1, "elapsed provider-pressure window is eligible");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("the cooling-off audit line re-arms when the pressure picture changes", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-grow-"));
  const { connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-grow-connector";
  let gaps = [pressureGap({ attemptCount: 6 })];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => gaps,
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() }]),
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    // Change the pressure picture (different max attempt -> different identity,
    // still a long cooldown) -> a fresh cooling-off skip arms.
    gaps = [pressureGap({ attemptCount: 5 })];
    await waitFor(() => cooldownSkips(completedRuns).length >= 2, 5000);
    scheduler.stop();

    assert.ok(
      cooldownSkips(completedRuns).length >= 2,
      "a changed pressure picture re-arms the cooling-off audit line"
    );
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("a future nextAttemptAfter floor is enforced, not only displayed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-floor-"));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, "floor.mjs");
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-floor-connector";
  const futureFloor = new Date(Date.now() + 2000).toISOString();

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 0, nextAttemptAfter: futureFloor })],
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 500 }]),
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    scheduler.stop();

    const skips = cooldownSkips(completedRuns);
    assert.equal(skips.length, 1, "future nextAttemptAfter should keep the connection cooling");
    assert.equal(
      policySkips(completedRuns).length,
      0,
      "the connector must not fall through as eligible before the floor"
    );
    assert.equal(readAttempts(attemptsPath).length, 0, "connector never spawned before the floor elapsed");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("a recovered run clears the cooldown — the connection becomes eligible again", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-recover-"));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, "recover.mjs");
  const completedRuns: RunRecord[] = [];
  const connectorId = "chatgpt-recover-connector";
  let gaps = [pressureGap({ attemptCount: 6 })];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => gaps,
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() }]),
  });

  try {
    scheduler.start();
    // First it cools off.
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    // Recover: the durable pressure set is now empty. The connection becomes
    // eligible and falls through to the policy gate (one skip per tick).
    gaps = [];
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    const cooldownBeforeRecovery = cooldownSkips(completedRuns).length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    assert.equal(
      cooldownSkips(completedRuns).length,
      cooldownBeforeRecovery,
      "no new cooling-off skips after recovery — the connection stopped cooling"
    );
    assert.ok(policySkips(completedRuns).length >= 1, "after recovery the connection is eligible (policy gate fires)");
    assert.equal(readAttempts(attemptsPath).length, 0, "policy-blocked manifest never spawns the connector");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("source-pressure cooldown does not bleed across connections", async () => {
  // Two connections sharing the recent anchor: one carries pressure (cools
  // off), the peer has none (stays eligible -> policy skips). The peer must
  // NEVER emit a cooling-off skip.
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-isolation-"));
  const pressured = writeUnusedConnector(tmpDir, "pressured.mjs");
  const peer = writeUnusedConnector(tmpDir, "peer.mjs");
  const completedRuns: RunRecord[] = [];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: "pressured-connector",
        connectorInstanceId: "pressured-connector",
        connectorPath: pressured.connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
      {
        connectorId: "peer-connector",
        connectorInstanceId: "peer-connector",
        connectorPath: peer.connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: (connectorId) =>
      connectorId === "pressured-connector" ? [pressureGap({ attemptCount: 6 })] : [],
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([
      { connectorId: "pressured-connector", lastRunTimeMs: Date.now() },
      { connectorId: "peer-connector", lastRunTimeMs: Date.now() },
    ]),
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).some((r) => r.connectorId === "pressured-connector"), 5000);
    // The peer keeps falling through to its policy gate (it is eligible).
    await waitFor(() => policySkips(completedRuns).some((r) => r.connectorId === "peer-connector"), 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    const peerCooldownSkips = cooldownSkips(completedRuns).filter((r) => r.connectorId === "peer-connector");
    assert.equal(peerCooldownSkips.length, 0, "the no-pressure peer must never be throttled by the cooldown");
    assert.ok(
      policySkips(completedRuns).some((r) => r.connectorId === "peer-connector"),
      "the peer stays eligible on its normal cadence"
    );
    // The pressured connector is cooling, not eligible: it must NOT have a
    // policy skip (the cooldown defers before the policy gate).
    assert.equal(
      policySkips(completedRuns).filter((r) => r.connectorId === "pressured-connector").length,
      0,
      "the pressured connector is deferred before the eligibility/policy gate"
    );
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("source-pressure probe failure must not silently suppress runs (fail-open)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cooldown-probe-failure-"));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, "probe-failure.mjs");
  const completedRuns: RunRecord[] = [];
  const connectorId = "cooldown-probe-failure-connector";

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId,
        connectorInstanceId: connectorId,
        connectorPath,
        intervalMs: 50,
        manifest: POLICY_BLOCKED_MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: () => {
      throw new Error("durable detail-gap store unreachable");
    },
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() }]),
  });

  try {
    scheduler.start();
    // A throwing probe is treated as "no pressure" — the connection stays
    // eligible and falls through to the policy gate rather than going quiet.
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.equal(
      cooldownSkips(completedRuns).length,
      0,
      "a throwing pressure probe must NOT surface as a cooling-off suppression"
    );
    assert.ok(policySkips(completedRuns).length >= 1, "schedule stayed eligible despite probe failure");
    assert.equal(readAttempts(attemptsPath).length, 0, "policy-blocked manifest never spawns");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
