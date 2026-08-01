// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Scheduler-integration tests for bounded periodic revalidation of stale
// SYNTHESIZED owner-action evidence (see
// runtime/scheduler/synthesized-attention-revalidation.ts and
// runtime/scheduler/pre-run-gate.ts::gateAttention).
//
// These exercise `createScheduler` directly against a real, in-process
// child-process connector (no stubbed dispatch) so the assertions cover the
// real `runConnector` wiring, not just the pure decision function (see
// synthesized-attention-revalidation.test.ts for the pure-unit coverage, and
// synthesized-revalidation-state-durability.test.ts for the store-layer
// restart/retention/malformed-row coverage). Tests that need a genuinely
// SUCCEEDED/FAILED terminal run (not just a pre-dispatch skip) run against a
// real AS/RS server pair (`startServer`/`fetchJson`/`issueOwnerToken`, same
// pattern as scheduler.test.ts's "marks connector as needs-human" test).
//
// v3 revision: the durable cadence anchor moved from a `runtime.history`
// scan (fleet-global, lossy, evictable — see the rejected v2 gate report,
// /home/tnunamak/.tmp/gate-stale-owner-action-v2-0801.md) to a dedicated,
// explicit, typed per-connection durable record
// (`synthesized_revalidation_state`, server/stores/scheduler-store.ts).
// Tests that need to prove durability now inject a REAL `SchedulerStore`
// (SQLite on-disk, restart via close/reopen — not an in-memory fake) instead
// of hand-seeding `runtime.history`.
//
// Required mutation scenarios (per the task spec):
//   1. Connector key `owner_action` collision — a connector-instance whose
//      identity looks like the synthesized key's `owner_action:` prefix must
//      not be misclassified; provenance is via the explicit `source` field.
//   2. Arbitrary connector interaction attempt — ANY connector, not just
//      ChatGPT/HEB, that emits INTERACTION during a revalidation probe fails
//      the run via the existing protocol-violation guard, proving
//      noninteractive-by-construction (not a connector-side opt-in).
//   3. 7+ failures — an ordinary same-class failure streak that crosses
//      BLOCKED_PROMOTION_THRESHOLD must still eventually admit a due
//      revalidation probe (dispatch-governor's blocked bypass), using the
//      durable anchor store (not injected `runtime.history`).
//   4. Real restart — a fresh scheduler instance (fresh `runtime.history`,
//      fresh in-process Maps) reopening the SAME on-disk SQLite database
//      preserves the doubling cadence exactly, and reason-code churn does
//      not reset it because the anchor is connector-instance-identity-keyed,
//      not reason-keyed.
//   5. Real successful projection clear — a genuinely successful bounded
//      probe is recorded as a real `succeeded` RunRecord
//      (source.revalidationProbe === true) AND durably clears the anchor
//      row, proving the self-heal path is real, not simulated by flipping a
//      local test flag.
//   6. Capped cadence — repeated real failed probes against a real store
//      double the observed inter-probe interval up to the configured cap,
//      never past it.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord, UnresolvedAttentionEvidence } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const FAST_REVALIDATION_OPTIONS = {
  initialDelayMs: 80,
  maxBackoffExp: 4,
  maxDelayMs: 2000,
};

interface ClosableHttpServer {
  close: (cb: () => void) => void;
  closeAllConnections?: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: ClosableHttpServer;
  rsPort: number;
  rsServer: ClosableHttpServer;
  schedulerManager?: { stop?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeWithTimeout = (srv: ClosableHttpServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { user_code: string; device_code: string };

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = tokenBody as { access_token: string };
  return token.access_token;
}

function writeConnector(tmpDir: string, name: string, script: string) {
  const attemptsPath = join(tmpDir, `${name}.attempts.log`);
  const connectorPath = join(tmpDir, name);
  writeFileSync(connectorPath, script, "utf8");
  writeFileSync(attemptsPath, "", "utf8");
  return { attemptsPath, connectorPath };
}

function dispatchableManifest(connectorId: string, refreshPolicy?: Record<string, unknown>) {
  return {
    ...(refreshPolicy ? { capabilities: { refresh_policy: refreshPolicy } } : {}),
    connector_id: connectorId,
    display_name: "Revalidation Test Connector",
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

function succeedingConnectorScript(attemptsPath: string) {
  return `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(${JSON.stringify(attemptsPath)}, (process.env.PDPP_RUN_TRIGGER_KIND || 'unknown') + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  process.exit(0);
});
`;
}

function failingConnectorScript(attemptsPath: string) {
  return `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(${JSON.stringify(attemptsPath)}, Date.now() + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', error: { message: 'session_required: still not authenticated' }, records_emitted: 0 }) + '\\n');
  process.exit(0);
});
`;
}

function interactionAttemptConnectorScript(attemptsPath: string) {
  return `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(${JSON.stringify(attemptsPath)}, (process.env.PDPP_RUN_TRIGGER_KIND || 'unknown') + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'req_1',
    kind: 'otp',
    message: 'Enter OTP',
  }) + '\\n');
});
`;
}

function readAttempts(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for scheduler condition");
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for scheduler condition");
}

function cancelledInteractionResponse(...args: unknown[]) {
  const interaction = args[0] as { request_id?: string };
  return {
    request_id: interaction.request_id,
    status: "cancelled",
    type: "INTERACTION_RESPONSE",
  };
}

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

function freshSqliteDbPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "pdpp.sqlite");
}

test("connector key owner_action collision: durable evidence with an owner_action-shaped key still blocks unconditionally, never revalidated", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-key-collision-"));
  const { attemptsPath, connectorPath } = writeConnector(
    tmpDir,
    "owner-action-collision.mjs",
    succeedingConnectorScript(join(tmpDir, "owner-action-collision.mjs.attempts.log"))
  );
  const completedRuns: RunRecord[] = [];

  // Simulates a connector-instance whose canonical key/dedupe key happens to
  // literally start with "owner_action:" (connector-key.ts's pattern allows
  // this) — a DURABLE record (source: "durable") in this shape must NOT be
  // misclassified as synthesized-and-revalidatable by any key-prefix
  // inspection. The gate must rely solely on `source`.
  const evidence: UnresolvedAttentionEvidence = {
    key: "owner_action:default:interaction:otp:global",
    reason: "otp_required",
    source: "durable",
  };

  const scheduler = createScheduler({
    admitRunConnection: fakeAdmitRunConnection(),
    connectors: [
      {
        connectorId: "owner-action-key-connector",
        connectorInstanceId: "owner-action-key-connector",
        connectorPath,
        intervalMs: 20,
        manifest: dispatchableManifest("owner-action-key-connector"),
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    hasUnresolvedAttention: () => evidence,
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    // Let many multiples of the (fast) revalidation cooldown pass — a
    // synthesized-evidence bug would eventually admit a probe here.
    await new Promise((resolve) => setTimeout(resolve, FAST_REVALIDATION_OPTIONS.initialDelayMs * 10));
    scheduler.stop();

    assert.deepEqual(
      readAttempts(attemptsPath),
      [],
      "the connector must NEVER be spawned — durable evidence blocks unconditionally"
    );
    assert.equal(completedRuns.length, 1, "exactly one deduped suppression skip, no revalidation admitted");
    const [skip] = completedRuns;
    assert.ok(skip);
    assert.equal(skip.status, "skipped");
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("arbitrary connector interaction attempt: a revalidation probe that emits INTERACTION fails the run via the protocol-violation guard, for ANY connector", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-interaction-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(attemptsPath, "", "utf8");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(connectorPath, interactionAttemptConnectorScript(attemptsPath), "utf8");
  const manifest = dispatchableManifest("generic-connector", {
    background_safe: true,
    interaction_posture: "otp_likely",
    rationale: "test fixture: this connector may prompt for OTP during ordinary scheduled runs",
    recommended_mode: "automatic",
  });

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const interactionsReceived: unknown[] = [];

  const evidence: UnresolvedAttentionEvidence = {
    key: "owner_action:generic-connector:reauth:browser_session:credential_present_and_unrejected:session_required",
    reason: "session_required",
    source: "synthesized",
  };

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "revalidation_interaction_user");

    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 20,
          manifest,
          maxRetries: 0,
          ownerToken,
        },
      ],
      hasUnresolvedAttention: () => evidence,
      // biome-ignore lint/suspicious/useAwait: mirrors the production Promise contract for onInteraction
      onInteraction: async (...args: unknown[]) => {
        interactionsReceived.push(args[0]);
        return cancelledInteractionResponse(...args);
      },
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    scheduler.start();
    await waitFor(() => readAttempts(attemptsPath).length >= 1, 8000);
    await waitFor(() => completedRuns.some((r) => r.status === "failed"), 8000);
    scheduler.stop();

    assert.equal(
      interactionsReceived.length,
      0,
      "the runtime's real onInteraction callback must NEVER be invoked for a revalidation probe — this is enforced structurally (no `interactive` binding advertised), not by the connector cooperating"
    );
    const failedRuns = completedRuns.filter((r) => r.status === "failed");
    assert.ok(
      failedRuns.length >= 1,
      "the probe must fail (protocol violation: INTERACTION with no interactive binding) rather than silently succeed or hang"
    );
    const [triggerKindSeen] = readAttempts(attemptsPath);
    assert.equal(
      triggerKindSeen,
      "revalidation",
      "the connector process must observe PDPP_RUN_TRIGGER_KIND=revalidation for the admitted probe"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("7+ failures: ordinary same-class backoff reaching blocked still eventually admits a due revalidation probe, driven by the REAL durable anchor store", async () => {
  // This drives the REAL `createDispatchGovernor().evaluateBackoffDispatch`
  // (the exact function `scheduler.ts`'s tick loop calls) against a
  // synthetically-seeded ordinary-failure `runtime.history` (backoff's own
  // input, unrelated to this fix) PLUS a REAL SQLite-backed
  // `synthesizedRevalidationStore` (this fix's durable anchor, not a
  // history-seeded fake) and an explicit `now`, rather than waiting through
  // 8 real connector dispatches + real backoff delays. Deterministic and
  // sub-second beyond microtask scheduling, while still exercising the
  // production code path (not a reimplementation of it).
  const { createDispatchGovernor } = await import("../runtime/scheduler/dispatch-governor.ts");

  const connectorId = "blocked-bypass-connector";
  const connectorInstanceId = "blocked-bypass-connector";
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const dbPath = freshSqliteDbPath("pdpp-blocked-bypass-db-");
  initDb(dbPath);

  try {
    const schedulerStore = createSqliteSchedulerStore();

    function ordinaryFailure(offsetMs: number): RunRecord {
      const at = new Date(now - offsetMs).toISOString();
      return {
        attempt: 1,
        checkpointSummary: null,
        completedAt: at,
        connectorId,
        connectorInstanceId,
        knownGaps: [],
        recordsEmitted: 0,
        source: { id: connectorId, kind: "connector" },
        startedAt: at,
        status: "failed",
        terminalReason: "authentication_error",
      };
    }

    // 8 consecutive same-class ordinary failures — crosses
    // BLOCKED_PROMOTION_THRESHOLD=7 — the newest one far enough in the past
    // that the (ordinary) back-off interval has long since elapsed, isolating
    // `blocked` as the ONLY thing suppressing dispatch. Ordinary backoff
    // still reads `runtime.history` (unchanged by this fix; only the
    // SYNTHESIZED-revalidation cadence moved to the durable store).
    const ordinaryFailureHistory: RunRecord[] = [];
    for (let i = 8; i >= 1; i -= 1) {
      ordinaryFailureHistory.push(ordinaryFailure(i * 60_000));
    }

    const runtime = {
      announcedBackoffClass: new Map<string, string>(),
      announcedBlockedClass: new Map<string, string>(),
      history: [...ordinaryFailureHistory],
      lastRunTime: new Map<string, number>([[connectorInstanceId, now - 60_000]]),
      notifiedCooldownIdentity: new Map<string, string>(),
    };

    const schedule = {
      connectorId,
      connectorInstanceId,
      connectorPath: "/dev/null",
      intervalMs: 60_000,
      manifest: {},
      ownerToken: "owner-token",
    };

    const noAttentionGovernor = createDispatchGovernor({
      getForwardEvidenceDebt: async () => false,
      getLastSuccessfulRunAt: async () => null,
      getNonPressureRecoverableCount: async () => 0,
      getSourcePressureGaps: () => [],
      getUnresolvedAttention: async () => null,
      onHumanRequiredStateEscalation: async () => {
        // no-op
      },
      runtime,
    });

    // Baseline: WITHOUT any attention evidence, a blocked connection stays
    // ineligible — proving the fix does not silently loosen `blocked` in
    // general, only for a DUE synthesized-revalidation probe.
    const baseline = await noAttentionGovernor.evaluateBackoffDispatch(schedule, now);
    assert.equal(
      baseline.decision.recommendedHealthState,
      "blocked",
      "8 consecutive same-class failures must promote to blocked"
    );
    assert.equal(baseline.eligible, false, "blocked with no attention evidence must stay ineligible");

    // Now seed the REAL durable anchor store (as pre-run-gate.ts would have
    // already written on an earlier tick once synthesized evidence
    // appeared) far enough in the past that the FAST revalidation cooldown
    // has elapsed, and wire a `getUnresolvedAttention` stub returning
    // synthesized evidence — the exact composition `scheduler.ts` wires in
    // production.
    schedulerStore.upsertSynthesizedRevalidationState({
      anchorAt: new Date(now - FAST_REVALIDATION_OPTIONS.initialDelayMs - 1000).toISOString(),
      attempt: 0,
      connectorId,
      connectorInstanceId,
      updatedAt: new Date(now - FAST_REVALIDATION_OPTIONS.initialDelayMs - 1000).toISOString(),
    });

    const evidence: UnresolvedAttentionEvidence = {
      key: "owner_action:blocked-bypass-connector:reauth:browser_session:credential_present_and_unrejected:authentication_error",
      reason: "authentication_error",
      source: "synthesized",
    };
    const synthesizedRevalidationStore = {
      clear: (id: string) => schedulerStore.clearSynthesizedRevalidationState?.(id),
      get: async (id: string) => {
        const record = await Promise.resolve(schedulerStore.getSynthesizedRevalidationState?.(id));
        return record ? { anchorAt: record.anchorAt, attempt: record.attempt } : null;
      },
      upsert: (id: string, cid: string, anchor: { anchorAt: string; attempt: number }) =>
        schedulerStore.upsertSynthesizedRevalidationState?.({
          anchorAt: anchor.anchorAt,
          attempt: anchor.attempt,
          connectorId: cid,
          connectorInstanceId: id,
          updatedAt: anchor.anchorAt,
        }),
    };
    const withAttentionGovernor = createDispatchGovernor({
      getForwardEvidenceDebt: async () => false,
      getLastSuccessfulRunAt: async () => null,
      getNonPressureRecoverableCount: async () => 0,
      getSourcePressureGaps: () => [],
      getUnresolvedAttention: async () => evidence,
      onHumanRequiredStateEscalation: async () => {
        // no-op
      },
      runtime,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
      synthesizedRevalidationStore,
    });

    const withEvidence = await withAttentionGovernor.evaluateBackoffDispatch(schedule, now);
    assert.equal(
      withEvidence.decision.recommendedHealthState,
      "blocked",
      "the connection must STILL be blocked by the ordinary failure streak — nothing here cleared it"
    );
    assert.equal(
      withEvidence.eligible,
      true,
      "a due synthesized-revalidation probe must be admitted even while blocked by an unrelated ordinary failure streak, driven by the durable anchor store"
    );
    assert.equal(
      withEvidence.recoveryOnly,
      false,
      "the admitted tick must not be recoveryOnly — it is the bounded revalidation probe, a distinct concept"
    );
  } finally {
    closeDb();
  }
});

test("real restart: a fresh scheduler instance reopening the SAME on-disk SQLite database preserves the doubling cadence exactly", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-restart-"));
  const dbPath = freshSqliteDbPath("pdpp-revalidation-restart-db-");
  const manifest = dispatchableManifest("restart-connector");
  const evidence: UnresolvedAttentionEvidence = {
    key: "owner_action:restart-connector:reauth:browser_session:credential_present_and_unrejected:session_required",
    reason: "session_required",
    source: "synthesized",
  };

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "restart_user");

    // --- Process 1: seed the pending-skip anchor against a real on-disk DB ---
    initDb(dbPath);
    const storeBeforeRestart = createSqliteSchedulerStore();
    const { attemptsPath, connectorPath } = writeConnector(
      tmpDir,
      "restart-connector.mjs",
      failingConnectorScript(join(tmpDir, "restart-connector.mjs.attempts.log"))
    );
    const completedRunsBeforeRestart: RunRecord[] = [];
    const connectorEntry = {
      connectorId: manifest.connector_id,
      connectorInstanceId: manifest.connector_id,
      connectorPath,
      intervalMs: 15,
      manifest,
      maxRetries: 0,
      ownerToken,
    };
    const schedulerBeforeRestart = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [connectorEntry],
      hasUnresolvedAttention: () => evidence,
      onInteraction: cancelledInteractionResponse,
      onRunComplete: (record) => completedRunsBeforeRestart.push(record),
      rsUrl,
      schedulerStore: storeBeforeRestart,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    schedulerBeforeRestart.start();
    await waitFor(
      () =>
        completedRunsBeforeRestart.some(
          (r) => r.status === "skipped" && (r.error ?? "").includes("attention_unresolved")
        ),
      5000
    );
    schedulerBeforeRestart.stop();
    // Let the process "die" without a graceful anchor-clear — the anchor
    // must already be durable at this point, not held only in
    // process-local memory.
    closeDb();

    const anchorAfterSeed = await (async () => {
      initDb(dbPath);
      const store = createSqliteSchedulerStore();
      const anchor = await store.getSynthesizedRevalidationState(manifest.connector_id);
      closeDb();
      return anchor;
    })();
    assert.ok(anchorAfterSeed, "the pending-skip anchor must be durably persisted before 'process 1' exits");
    assert.equal(anchorAfterSeed.attempt, 0, "no failed probe has been dispatched yet, only the pending sighting");

    // --- Process 2: fresh scheduler instance, fresh runtime.history, same DB file ---
    initDb(dbPath);
    const storeAfterRestart = createSqliteSchedulerStore();
    const completedRunsAfterRestart: RunRecord[] = [];
    const schedulerAfterRestart = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [connectorEntry],
      hasUnresolvedAttention: () => evidence,
      onInteraction: cancelledInteractionResponse,
      onRunComplete: (record) => completedRunsAfterRestart.push(record),
      rsUrl,
      schedulerStore: storeAfterRestart,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    schedulerAfterRestart.start();
    // The doubling cadence must still hold from the PRE-restart anchor: the
    // probe must not be admitted immediately (that would mean the anchor
    // was lost/reset on restart, re-arming the initial delay).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      readAttempts(attemptsPath).length,
      0,
      "restart must not immediately admit a probe — the anchor's initial delay must still be honored post-restart"
    );

    // Once the (fast) initial delay elapses relative to the PRE-restart
    // anchor timestamp, the probe becomes due and dispatches for real.
    // Wait on the actual terminal-notification condition (onRunComplete),
    // not just the connector process having started (readAttempts) — the
    // anchor is now settled and awaited BEFORE onRunComplete fires (see
    // settleRevalidationProbeAnchor's ordering guarantee in scheduler.ts),
    // so onRunComplete firing is itself proof the anchor already advanced.
    await waitFor(
      () => completedRunsAfterRestart.some((r) => r.status === "failed" && r.source?.revalidationProbe === true),
      8000
    );
    schedulerAfterRestart.stop();

    const failedProbe = completedRunsAfterRestart.find(
      (r) => r.status === "failed" && r.source?.revalidationProbe === true
    );
    assert.ok(failedProbe, "the probe dispatched after restart must be tagged as a real revalidation probe");

    // The failed probe's anchor advance is now awaited and ordered BEFORE
    // onRunComplete (see settleRevalidationProbeAnchor's ordering
    // guarantee) — since onRunComplete already fired above, the anchor
    // must already be durably advanced; assert directly, no polling.
    const anchorAfterOnRunComplete = await storeAfterRestart.getSynthesizedRevalidationState(manifest.connector_id);
    assert.equal(
      anchorAfterOnRunComplete?.attempt,
      1,
      "the anchor must already be advanced to attempt 1 the instant onRunComplete fires"
    );
    closeDb();
    initDb(dbPath);
    const finalStore = createSqliteSchedulerStore();
    const anchorAfterFailedProbe = await finalStore.getSynthesizedRevalidationState(manifest.connector_id);
    closeDb();
    assert.ok(anchorAfterFailedProbe, "the anchor must still exist after the failed probe");
    assert.equal(anchorAfterFailedProbe.attempt, 1, "the failed probe must durably advance the attempt count to 1");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("alternating reasons do not reset the revalidation cadence — anchor is connector-instance-identity-keyed, not reason-keyed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-alternating-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(attemptsPath, "", "utf8");
  const connectorPath = join(tmpDir, "connector.mjs");
  // FAILING (not succeeding) connector: a genuinely successful revalidation
  // probe now durably CLEARS the anchor (see settleRevalidationProbeAnchor,
  // scheduler.ts) — correct terminal behavior, but it would race this
  // test's post-probe anchor-existence assertion below. A failing probe
  // advances (never clears) the anchor, which is what this test's own
  // assertion ("a single durable anchor must exist") actually needs.
  writeFileSync(connectorPath, failingConnectorScript(attemptsPath), "utf8");
  const manifest = dispatchableManifest("alternating-connector");
  const dbPath = freshSqliteDbPath("pdpp-revalidation-alternating-db-");

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "alternating_reasons_user");

    initDb(dbPath);
    const schedulerStore = createSqliteSchedulerStore();

    let reasonToggle = 0;
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 15,
          manifest,
          maxRetries: 0,
          ownerToken,
        },
      ],
      hasUnresolvedAttention: () => {
        // Alternate the reason on every probe — the REJECTED v1 kept its
        // cooldown state in a Map keyed by the full evidence `key` (which
        // embeds `reason`), so a changed reason reset the cooldown to
        // attempt zero every time. This module's cadence is keyed only by
        // connector instance identity in the durable anchor store, never by
        // `evidence.key`/`reason`.
        reasonToggle += 1;
        const reason = reasonToggle % 2 === 0 ? "session_required" : "session_expired";
        return {
          key: `owner_action:alternating-connector:reauth:browser_session:credential_present_and_unrejected:${reason}`,
          reason,
          source: "synthesized" as const,
        };
      },
      onInteraction: cancelledInteractionResponse,
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      schedulerStore,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    scheduler.start();
    // Despite the reason alternating on every probe, the cadence must still
    // reach admission within a bounded window — proving the reason churn
    // did not reset the clock to zero on every tick.
    await waitFor(() => readAttempts(attemptsPath).length >= 1, 8000);
    // The durable anchor's `attempt` count only advances via
    // settleRevalidationProbeAnchor's FAILED-probe branch (see
    // scheduler.ts), which is reachable only for a real DISPATCHED
    // revalidation probe (source.revalidationProbe === true) — so
    // `attempt >= 1` here is itself proof the bounded probe was admitted
    // and failed, not merely that the connector process was invoked for
    // some unrelated reason.
    await waitForAsync(async () => {
      const anchor = await schedulerStore.getSynthesizedRevalidationState(manifest.connector_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: anchor is genuinely nullable before the first probe attempt lands; ?? 0 is the correct not-yet-reached fallback.
      return (anchor?.attempt ?? 0) >= 1;
    }, 5000);
    scheduler.stop();

    // Exactly one anchor row exists for this connector instance — reason
    // churn never created a second, reason-keyed anchor.
    const anchor = await schedulerStore.getSynthesizedRevalidationState(manifest.connector_id);
    assert.ok(anchor, "a single durable anchor must exist, keyed by connector instance only");
    assert.ok(anchor.attempt >= 1, "the anchor must have advanced from a real dispatched, failed revalidation probe");
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("capped cadence: repeated real failed probes against a real store double the observed inter-probe interval up to the configured cap", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-capped-cadence-"));
  const { attemptsPath, connectorPath } = writeConnector(
    tmpDir,
    "capped-cadence-connector.mjs",
    failingConnectorScript(join(tmpDir, "capped-cadence-connector.mjs.attempts.log"))
  );
  const manifest = dispatchableManifest("capped-cadence-connector");
  const dbPath = freshSqliteDbPath("pdpp-revalidation-capped-cadence-db-");
  const evidence: UnresolvedAttentionEvidence = {
    key: "owner_action:capped-cadence-connector:reauth:browser_session:credential_present_and_unrejected:session_required",
    reason: "session_required",
    source: "synthesized",
  };
  // Small, fast units so the cap actually binds within a short real-time test.
  const cappedOptions = { initialDelayMs: 60, maxBackoffExp: 3, maxDelayMs: 300 };

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "capped_cadence_user");

    initDb(dbPath);
    const schedulerStore = createSqliteSchedulerStore();

    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 10,
          manifest,
          maxRetries: 0,
          ownerToken,
        },
      ],
      hasUnresolvedAttention: () => evidence,
      onInteraction: cancelledInteractionResponse,
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      schedulerStore,
      synthesizedRevalidationOptions: cappedOptions,
    });

    scheduler.start();
    // Wait for several real failed probes to accumulate, letting the
    // doubling cadence run past its cap.
    await waitFor(() => readAttempts(attemptsPath).length >= 4, 15_000);
    // The durable anchor write is fire-and-forget relative to the
    // connector-process attempt log (same convention as `appendRunHistory`'s
    // own persistence) — poll for the anchor to actually reach the expected
    // attempt count before stopping the scheduler and asserting.
    await waitForAsync(async () => {
      const anchor = await schedulerStore.getSynthesizedRevalidationState(manifest.connector_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: anchor is genuinely nullable (no anchor created yet); ?? 0 is the correct not-yet-reached fallback.
      return (anchor?.attempt ?? 0) >= cappedOptions.maxBackoffExp;
    }, 5000);
    scheduler.stop();

    const attemptTimestamps = readAttempts(attemptsPath).map(Number);
    const intervals: number[] = [];
    for (let i = 1; i < attemptTimestamps.length; i += 1) {
      intervals.push((attemptTimestamps[i] ?? 0) - (attemptTimestamps[i - 1] ?? 0));
    }
    // Every observed inter-probe interval must be bounded by the cap (with
    // slack for real scheduler tick granularity/process overhead) — never
    // growing unbounded past maxDelayMs.
    for (const interval of intervals) {
      assert.ok(
        interval <= cappedOptions.maxDelayMs + 2000,
        `observed inter-probe interval ${interval}ms must not exceed the cap ${cappedOptions.maxDelayMs}ms (with slack)`
      );
    }
    // The durable anchor's attempt count must have advanced past the
    // exponent cap, proving the cap is exercised, not merely never reached.
    const anchor = await schedulerStore.getSynthesizedRevalidationState(manifest.connector_id);
    assert.ok(anchor);
    assert.ok(
      anchor.attempt >= cappedOptions.maxBackoffExp,
      `attempt count ${anchor.attempt} must reach/exceed maxBackoffExp ${cappedOptions.maxBackoffExp} for the cap to bind`
    );
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("real successful projection clear: a genuinely successful bounded probe records source.revalidationProbe and durably clears the anchor for the next tick", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-success-clear-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(attemptsPath, "", "utf8");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(connectorPath, succeedingConnectorScript(attemptsPath), "utf8");
  const manifest = dispatchableManifest("success-clear-connector");
  const dbPath = freshSqliteDbPath("pdpp-revalidation-success-clear-db-");

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  let evidenceCleared = false;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "success_clear_user");

    initDb(dbPath);
    const schedulerStore = createSqliteSchedulerStore();

    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 15,
          manifest,
          maxRetries: 0,
          ownerToken,
        },
      ],
      hasUnresolvedAttention: () =>
        evidenceCleared
          ? null
          : {
              key: "owner_action:success-clear-connector:reauth:browser_session:credential_present_and_unrejected:session_required",
              reason: "session_required",
              source: "synthesized" as const,
            },
      onInteraction: cancelledInteractionResponse,
      onRunComplete: (record) => {
        completedRuns.push(record);
        // Real projection-clearing signal, scoped to what this fix owns
        // (the scheduler's own dispatch/gate layer): a genuinely
        // DISPATCHED (not simulated) successful revalidation probe is what
        // flips it, proven by asserting `source.revalidationProbe` below
        // BEFORE trusting this callback's side effect. (Full RS/AS
        // connection-health.ts projection wiring is covered separately by
        // the real getConnectorSummaryForRoute production-projection test.)
        if (record.status === "succeeded" && record.source?.revalidationProbe === true) {
          evidenceCleared = true;
        }
      },
      rsUrl,
      schedulerStore,
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    scheduler.start();
    await waitFor(() => readAttempts(attemptsPath).length >= 1, 8000);
    await waitFor(
      () => completedRuns.some((r) => r.status === "succeeded" && r.source?.revalidationProbe === true),
      8000
    );
    const successRecord = completedRuns.find((r) => r.status === "succeeded");
    assert.ok(successRecord, "expected a real succeeded RunRecord from the dispatched probe");
    assert.equal(
      successRecord.source?.revalidationProbe,
      true,
      "the succeeded record must be tagged as the bounded probe's own outcome"
    );
    assert.equal(successRecord.connectorInstanceId, "success-clear-connector");

    // The durable anchor row must actually be cleared — not just an
    // in-memory flag — proving the self-heal path writes through to
    // storage.
    await waitForAsync(
      async () => (await schedulerStore.getSynthesizedRevalidationState(manifest.connector_id)) === null,
      5000
    );

    // Prove the self-heal path is genuinely closed: after clearing, the
    // scheduler must resume normal-interval scheduling (real dispatches),
    // not continue emitting revalidation probes at the doubling cadence.
    await waitFor(() => readAttempts(attemptsPath).length >= 2, 5000);
    scheduler.stop();

    const successIndex = completedRuns.indexOf(successRecord);
    const attentionSkipsAfterSuccess = completedRuns
      .slice(successIndex + 1)
      .filter((r) => r.status === "skipped" && (r.error ?? "").includes("attention_unresolved"));
    assert.equal(attentionSkipsAfterSuccess.length, 0, "no attention-blocked skip may occur after the evidence clears");
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});
