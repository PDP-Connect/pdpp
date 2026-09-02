// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import type {
  ConnectionAxes,
  ConnectionHealthCondition,
  ConnectionHealthSnapshot,
  DetailGapBacklog,
} from "../runtime/connection-health.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import type { RequiredAction, StreamRollup } from "../runtime/rendered-verdict.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import { evaluateSatisfactionContract, satisfiedOwnerActions } from "../runtime/satisfaction-watcher.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createRunManagedConnectorViaController } from "../server/scheduler-manager-factory.ts";
import type { ActiveRunRecord, ScheduleRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/self-heal-test";
const INSTANCE_ID = "cin_self_heal";
const OWNER_A = "owner_self_heal_a";
const OWNER_B = "owner_self_heal_b";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  connector_key: "self-heal-test",
  display_name: "Self Heal Test",
  streams: [],
  version: "1.0.0",
};
const MANUAL_REFRESH = {
  backgroundSafe: false,
  interactionPosture: "otp_likely" as const,
  recommendedMode: "manual" as const,
};

function action(overrides: Partial<RequiredAction> = {}): RequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Reconnect",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

interface SnapshotOverrides {
  axes?: Partial<ConnectionAxes>;
  badges?: Partial<ConnectionHealthSnapshot["badges"]>;
  conditions?: readonly ConnectionHealthCondition[];
  detail_gap_backlog?: DetailGapBacklog | null;
  dominant_condition_id?: string | null;
  forward_disposition?: ConnectionHealthSnapshot["forward_disposition"];
  last_success_at?: string | null;
  next_attempt_at?: string | null;
  reason_code?: string | null;
  state?: ConnectionHealthSnapshot["state"];
}

function snapshot(overrides: SnapshotOverrides = {}): ConnectionHealthSnapshot {
  const axes: ConnectionAxes = {
    attention: "none",
    coverage: "complete",
    freshness: "fresh",
    outbox: "idle",
    remote_surface: "none",
    ...(overrides.axes ?? {}),
  };
  return {
    axes,
    badges: { stale: false, syncing: false, ...(overrides.badges ?? {}) },
    collection_rate: null,
    conditions: overrides.conditions ?? [],
    coverage_horizons: [],
    detail_gap_backlog: overrides.detail_gap_backlog ?? null,
    dominant_condition_id: overrides.dominant_condition_id ?? null,
    ephemeral_browser_runtime: null,
    forward_disposition: overrides.forward_disposition ?? "complete",
    last_success_at: overrides.last_success_at ?? null,
    local_device_outbox_counts: null,
    next_action: null,
    next_attempt_at: overrides.next_attempt_at ?? null,
    reason_code: overrides.reason_code ?? null,
    remote_surface: null,
    state: overrides.state ?? "healthy",
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function stream(overrides: Partial<StreamRollup> = {}): StreamRollup {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "s1",
    ...overrides,
  };
}

function condition(overrides: Partial<ConnectionHealthCondition> = {}): ConnectionHealthCondition {
  return {
    current: true,
    expires_at: null,
    id: "Cond:reason",
    message: "m",
    observed_at: null,
    origin: "connector",
    reason: "reason",
    reason_code: null,
    remediation: null,
    sensitivity: "owner",
    severity: "error",
    status: "false",
    type: "CredentialsValid",
    ...overrides,
  };
}

function detailGapBacklog(overrides: Partial<DetailGapBacklog> = {}): DetailGapBacklog {
  return {
    max_attempt_count: 0,
    next_attempt_at: null,
    pending: 0,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: null,
    terminal: null,
    ...overrides,
  };
}

// A minimal, production-shaped admission fixture: mints a deterministic
// default-account connector_instance_id per (ownerSubjectId, connectorId) and
// echoes back an explicitly requested one (both `autoResumeSatisfiedActions`
// calls below always pass an explicit `connectorInstanceId: INSTANCE_ID`) —
// the same authority shape `admitOwnerRunConnection` enforces in production,
// without a real store.
function fakeAdmitRunConnection(
  admissions: string[] = []
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
  runAdmission: "browser_enrollment" | "collection" | "setup";
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId, runAdmission }) => {
    admissions.push(runAdmission);
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function createSchedulerStore(): SchedulerStore {
  const activeRuns = new Map<string, ActiveRunRecord>();
  const schedules = new Map<string, ScheduleRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: (record) => {
      const key = record.connector_instance_id ?? record.connector_id;
      schedules.set(key, {
        connector_id: record.connector_id,
        connector_instance_id: key,
        created_at: record.created_at,
        enabled: record.enabled,
        interval_seconds: record.interval_seconds,
        jitter_seconds: record.jitter_seconds,
        updated_at: record.updated_at,
      });
    },
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) {
        activeRuns.delete(connectorInstanceId);
      }
    },
    deleteSchedule: (connectorInstanceId) => {
      schedules.delete(connectorInstanceId);
    },
    getActiveRun: (connectorInstanceId) => activeRuns.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: (connectorInstanceId) => schedules.get(connectorInstanceId) ?? null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [...schedules.values()],
    setScheduleEnabled: (connectorInstanceId, enabled, updatedAt) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, enabled, updated_at: updatedAt });
      }
    },
    updateSchedule: (connectorInstanceId, patch) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, ...patch });
      }
    },
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-self-heal-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function completeRunConnector(calls: RuntimeRunConnectorOptions[]) {
  return async (opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult> => {
    calls.push(opts);
    const { traceContext } = opts;
    assert.ok(traceContext);
    await emitSpineEvent({
      actor_id: opts.connectorId,
      actor_type: "runtime",
      data: { records_emitted: 1, source: { connector_id: opts.connectorId } },
      event_type: "run.completed",
      object_id: opts.runId ?? null,
      object_type: "run",
      run_id: opts.runId ?? null,
      scenario_id: traceContext.scenario_id,
      status: "completed",
      trace_id: traceContext.trace_id,
    });
    return { records_emitted: 1, status: "succeeded" };
  };
}

function failRunConnector(calls: RuntimeRunConnectorOptions[]) {
  return async (opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult> => {
    calls.push(opts);
    const { traceContext } = opts;
    assert.ok(traceContext);
    await emitSpineEvent({
      actor_id: opts.connectorId,
      actor_type: "runtime",
      data: { failure_reason: "same_gap_recurred", reason: "same_gap_recurred" },
      event_type: "run.failed",
      object_id: opts.runId ?? null,
      object_type: "run",
      run_id: opts.runId ?? null,
      scenario_id: traceContext.scenario_id,
      status: "failed",
      trace_id: traceContext.trace_id,
    });
    return { records_emitted: 0, status: "failed" };
  };
}

function writeOwnerSnapshotConnector(tmpDir: string, snapshotPath: string): string {
  const connectorPath = join(tmpDir, "owner-snapshot.mjs");
  writeFileSync(
    connectorPath,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const snapshotPath = process.env.SELF_HEAL_SNAPSHOT_PATH ?? ${JSON.stringify(snapshotPath)};
  writeFileSync(snapshotPath, JSON.stringify({
    ownerToken: process.env.PDPP_OWNER_TOKEN ?? null,
    secret: process.env.SELF_HEAL_SECRET ?? null,
  }), 'utf8');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  setTimeout(() => process.exit(0), 10);
});
`,
    "utf8"
  );
  return connectorPath;
}

test("satisfaction watcher evaluates every unified contract kind from durable evidence", () => {
  assert.equal(
    evaluateSatisfactionContract(action(), {
      credential: { present: true, rejected: false, status: "active" },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "attention_resolved" } }), {
      conditions: [condition({ severity: "info", status: "true" })],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "confirming_run_succeeded" } }), {
      lastRun: { status: "succeeded" },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ affects: ["messages"], satisfied_when: { kind: "gap_recovered" } }), {
      streams: [{ coverage: "complete", stream_id: "messages" }],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "schedule_attached_and_enabled" } }), {
      schedule: { enabled: true },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(
      action({ affects: ["messages"], satisfied_when: { kind: "backfill_window_covered" } }),
      {
        streams: [{ coverage: "complete", stream_id: "messages" }],
      }
    ),
    true
  );
  assert.equal(
    satisfiedOwnerActions([action({ audience: "none", satisfied_when: { kind: "none" } })], {}).length,
    0,
    "none contracts are not owner-satisfiable even though they are terminally satisfied"
  );
});

test("satisfying a reauth action auto-resumes on the existing connection and can flip green", async (t) => {
  freshDb(t);
  const calls: RuntimeRunConnectorOptions[] = [];
  const admissions: string[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(admissions),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: completeRunConnector(calls),
    schedulerStore: createSchedulerStore(),
  });

  const before = synthesizeRenderedVerdict(
    snapshot({ conditions: [condition({ reason: "credential_rejected" })], state: "needs_attention" }),
    [stream()],
    null,
    true
  );
  const [beforeReauthAction] = before.required_actions;
  assert.ok(beforeReauthAction);
  assert.equal(beforeReauthAction.kind, "reauth");

  const resumed = await controller.autoResumeSatisfiedActions({
    awaitCompletion: true,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    evidence: { credential: { present: true, rejected: false, status: "active" } },
    manifest: MANIFEST,
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
    requiredActions: before.required_actions,
    runId: "run_self_heal_reauth",
  });

  assert.equal(resumed.status, "started");
  assert.equal(resumed.terminal_status, "succeeded");
  assert.equal(resumed.confirming_run?.run_id, "run_self_heal_reauth");
  assert.equal(calls.length, 1, "exactly one confirming run is launched");
  const [firstCall] = calls;
  assert.ok(firstCall);
  assert.equal(firstCall.connectorInstanceId, INSTANCE_ID, "connection_id is preserved");
  assert.equal(firstCall.triggerKind, "manual", "owner repair clears owner-attention state without a second click");
  assert.deepEqual(admissions, ["setup"], "credential-repair auto-resume uses the setup admission capability");

  const after = synthesizeRenderedVerdict(
    snapshot({ last_success_at: "2026-06-15T12:00:00.000Z" }),
    [stream()],
    null,
    true
  );
  assert.equal(after.pill.tone, "green");
  assert.equal(after.required_actions.length, 0);
});

test("credential auto-resume uses the repair owner's connection, credential, token, and child", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-self-heal-owner-isolation-"));
  const snapshotPath = join(tmpDir, "owner-b.json");
  const connectorPath = writeOwnerSnapshotConnector(tmpDir, snapshotPath);
  const admittedOwners: string[] = [];
  const resolverOwners: string[] = [];

  try {
    const controller = createController({
      admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
        admittedOwners.push(ownerSubjectId);
        return Promise.resolve({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? "cin_self_heal_owner_b",
        });
      },
      connectorPathResolver: () => connectorPath,
      logger: { error: () => undefined, warn: () => undefined },
      maxRunWallClockMs: 5000,
      ownerSubjectId: OWNER_A,
      resolveStaticSecretRunEnv: ({ connectorInstanceId, ownerSubjectId }) => {
        assert.equal(connectorInstanceId, "cin_self_heal_owner_b");
        resolverOwners.push(ownerSubjectId);
        return { SELF_HEAL_SECRET: `${ownerSubjectId}-secret` };
      },
      schedulerStore: createSchedulerStore(),
    });

    const resumed = await controller.autoResumeSatisfiedActions({
      awaitCompletion: true,
      connectorId: CONNECTOR_ID,
      connectorInstanceId: "cin_self_heal_owner_b",
      evidence: { credential: { present: true, rejected: false, status: "active" } },
      manifest: { ...MANIFEST, streams: [{ name: "items" }] },
      ownerSubjectId: OWNER_B,
      ownerToken: `token-${OWNER_B}`,
      requiredActions: [action()],
      runId: "run_self_heal_owner_b",
    });

    assert.equal(resumed.status, "started");
    assert.equal(resumed.terminal_status, "succeeded");
    assert.deepEqual(admittedOwners, [OWNER_B], "controller closure owner A must not admit the repair run");
    assert.deepEqual(resolverOwners, [OWNER_B], "credential recovery must use the repair owner");
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), {
      ownerToken: `token-${OWNER_B}`,
      secret: `${OWNER_B}-secret`,
    });
    assert.equal(admittedOwners.includes(OWNER_A), false);
    assert.equal(resolverOwners.includes(OWNER_A), false);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("managed controller recovery preserves two per-run owners across a stale closure", async (t) => {
  freshDb(t);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-managed-owner-isolation-"));
  const snapshotA = join(tmpDir, "owner-a.json");
  const snapshotB = join(tmpDir, "owner-b.json");
  const connectorPath = writeOwnerSnapshotConnector(tmpDir, snapshotA);
  const admittedOwners: string[] = [];
  const resolverOwners: string[] = [];

  try {
    const controller = createController({
      admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
        admittedOwners.push(ownerSubjectId);
        return Promise.resolve({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? "cin_managed_owner_b",
        });
      },
      connectorPathResolver: () => connectorPath,
      logger: { error: () => undefined, warn: () => undefined },
      maxRunWallClockMs: 5000,
      ownerSubjectId: OWNER_A,
      resolveStaticSecretRunEnv: ({ connectorInstanceId, ownerSubjectId }) => {
        resolverOwners.push(ownerSubjectId);
        return {
          SELF_HEAL_SECRET: `${ownerSubjectId}-secret`,
          SELF_HEAL_SNAPSHOT_PATH: connectorInstanceId === "cin_managed_owner_a" ? snapshotA : snapshotB,
        };
      },
      schedulerStore: createSchedulerStore(),
    });
    const managedRunner = createRunManagedConnectorViaController({
      awaitRun: controller.awaitRun,
      browserSurfaceLeaseManager: { isManagedConnector: () => true },
      getActiveRun: (connectorId, options) => controller.getActiveRun(connectorId, options),
      isNeedsHuman: (connectorId, options) => controller.isNeedsHuman(connectorId, options),
      issueRuntimeOwnerToken: () => Promise.resolve("unused-owner-token"),
      markNeedsHuman: (connectorId, options) => controller.markNeedsHuman(connectorId, options),
      runNow: async (connectorId, options) => {
        const result = await controller.runNow(connectorId, {
          ...options,
          manifest: { ...MANIFEST, streams: [{ name: "items" }] },
        });
        if (typeof result.status !== "string") {
          throw new Error("managed test run did not return a status");
        }
        return { ...result, status: result.status };
      },
    });
    assert.ok(managedRunner);

    const runA = await managedRunner(CONNECTOR_ID, {
      connectorInstanceId: "cin_managed_owner_a",
      ownerSubjectId: OWNER_A,
      ownerToken: `token-${OWNER_A}`,
      priorityClass: "background",
      triggerKind: "scheduled",
    });
    const runB = await managedRunner(CONNECTOR_ID, {
      connectorInstanceId: "cin_managed_owner_b",
      ownerSubjectId: OWNER_B,
      ownerToken: `token-${OWNER_B}`,
      priorityClass: "background",
      triggerKind: "scheduled",
    });

    assert.equal(runA?.status, "succeeded");
    assert.equal(runB?.status, "succeeded");
    assert.deepEqual(admittedOwners, [OWNER_A, OWNER_B], "managed admission must use each run owner");
    assert.deepEqual(resolverOwners, [OWNER_A, OWNER_B], "managed credential recovery must use each run owner");
    assert.deepEqual(JSON.parse(readFileSync(snapshotA, "utf8")), {
      ownerToken: `token-${OWNER_A}`,
      secret: `${OWNER_A}-secret`,
    });
    assert.deepEqual(JSON.parse(readFileSync(snapshotB, "utf8")), {
      ownerToken: `token-${OWNER_B}`,
      secret: `${OWNER_B}-secret`,
    });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("an identical re-failure re-presents the same action and does not paint green", async (t) => {
  freshDb(t);
  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: failRunConnector(calls),
    schedulerStore: createSchedulerStore(),
  });
  const before = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale" },
      forward_disposition: "resumable",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true
  );
  const retry = before.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.ok(retry);

  const resumed = await controller.autoResumeSatisfiedActions({
    awaitCompletion: true,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    evidence: { detailGapBacklog: detailGapBacklog({ pending: 0 }) },
    manifest: MANIFEST,
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
    requiredActions: [retry],
    runId: "run_self_heal_refailure",
  });

  assert.equal(resumed.status, "started");
  assert.equal(resumed.terminal_status, "failed");
  assert.equal(calls.length, 1, "re-failure still launches only the one confirming run");

  const after = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale" },
      conditions: [
        condition({
          id: "TransactionsFetch:same_gap_recurred",
          reason: "same_gap_recurred",
          type: "SourceCoverageComplete",
        }),
      ],
      forward_disposition: "resumable",
      reason_code: "same_gap_recurred",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true
  );
  assert.equal(after.pill.tone, "amber");
  assert.equal(after.detail.reason_code, "same_gap_recurred");
  assert.ok(
    after.required_actions.some((entry) => entry.kind === "retry_gap"),
    "same action remains visible"
  );
});

test("partial recovery clears recovered stream action refs and keeps unrecovered stream action", () => {
  const baseSnapshot = snapshot({
    axes: { coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "resumable",
    state: "degraded",
  });
  const before = synthesizeRenderedVerdict(
    baseSnapshot,
    [
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" }),
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "accounts" }),
    ],
    MANUAL_REFRESH,
    true
  );
  const beforeRetry = before.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.deepEqual(beforeRetry?.affects, ["transactions", "accounts"]);

  const after = synthesizeRenderedVerdict(
    baseSnapshot,
    [
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" }),
      stream({ coverage: "complete", gap_retryable: false, stream_id: "accounts" }),
    ],
    MANUAL_REFRESH,
    true
  );

  const afterRetry = after.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.deepEqual(afterRetry?.affects, ["transactions"]);
  assert.notEqual(after.streams.find((row) => row.stream_id === "transactions")?.action_ref, null);
  assert.equal(after.streams.find((row) => row.stream_id === "accounts")?.action_ref, null);
});
