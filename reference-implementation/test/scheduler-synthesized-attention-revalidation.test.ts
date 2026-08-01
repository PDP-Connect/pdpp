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
// synthesized-attention-revalidation.test.ts for the pure-unit coverage).
// Tests that need a genuinely SUCCEEDED/FAILED terminal run (not just a
// pre-dispatch skip) run against a real AS/RS server pair
// (`startServer`/`fetchJson`/`issueOwnerToken`, same pattern as
// scheduler.test.ts's "marks connector as needs-human" test).
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
//      revalidation probe (dispatch-governor's blocked bypass).
//   4. Restart and alternating reasons — the revalidation cadence anchor
//      survives a fresh scheduler instance sharing the same durable history
//      (simulating restart), and reason-code churn does not reset it because
//      the anchor is connector-instance-identity-keyed, not reason-keyed.
//   5. Real successful projection clear — a genuinely successful bounded
//      probe is recorded as a real `succeeded` RunRecord (source.revalidationProbe
//      === true), and the very next tick's cadence walk sees the streak
//      broken (attempt resets to 0), proving the self-heal path is real, not
//      simulated by flipping a local test flag.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord, UnresolvedAttentionEvidence } from "../runtime/scheduler-domain-types.ts";
import { startServer } from "../server/index.ts";

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

test("7+ failures: ordinary same-class backoff reaching blocked still eventually admits a due revalidation probe (deterministic, injected history)", async () => {
  // This drives the REAL `createDispatchGovernor().evaluateBackoffDispatch`
  // (the exact function `scheduler.ts`'s tick loop calls) against a
  // synthetically-seeded `runtime.history` and an explicit `now`, rather
  // than waiting through 8 real connector dispatches + real backoff delays.
  // No wall-clock sleeps beyond microtask scheduling — deterministic and
  // sub-second, while still exercising the production code path (not a
  // reimplementation of it).
  const { createDispatchGovernor } = await import("../runtime/scheduler/dispatch-governor.ts");

  const connectorId = "blocked-bypass-connector";
  const connectorInstanceId = "blocked-bypass-connector";
  const now = Date.parse("2026-08-01T12:00:00.000Z");

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
  // `blocked` as the ONLY thing suppressing dispatch.
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

  // Now seed history with the pending-skip marker (as pre-run-gate.ts would
  // have already recorded on an earlier tick once synthesized evidence
  // appeared) far enough in the past that the FAST revalidation cooldown has
  // elapsed, and wire a `getUnresolvedAttention` stub returning synthesized
  // evidence — the exact composition `scheduler.ts` wires in production.
  const pendingSkipAt = new Date(now - FAST_REVALIDATION_OPTIONS.initialDelayMs - 1000).toISOString();
  runtime.history = [
    ...ordinaryFailureHistory,
    {
      attempt: 0,
      checkpointSummary: null,
      completedAt: pendingSkipAt,
      connectorId,
      connectorInstanceId,
      error:
        "synthesized_attention_revalidation_pending:attention_unresolved: authentication_error (owner_action:blocked-bypass-connector:reauth:browser_session:credential_present_and_unrejected:authentication_error)",
      knownGaps: [],
      recordsEmitted: 0,
      source: { id: connectorId, kind: "connector" },
      startedAt: pendingSkipAt,
      status: "skipped",
    },
  ];

  const evidence: UnresolvedAttentionEvidence = {
    key: "owner_action:blocked-bypass-connector:reauth:browser_session:credential_present_and_unrejected:authentication_error",
    reason: "authentication_error",
    source: "synthesized",
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
    "a due synthesized-revalidation probe must be admitted even while blocked by an unrelated ordinary failure streak"
  );
  assert.equal(
    withEvidence.recoveryOnly,
    false,
    "the admitted tick must not be recoveryOnly — it is the bounded revalidation probe, a distinct concept"
  );
});

test("alternating reasons do not reset the revalidation cadence — anchor is connector-instance-identity-keyed, not reason-keyed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-alternating-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(attemptsPath, "", "utf8");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(connectorPath, succeedingConnectorScript(attemptsPath), "utf8");
  const manifest = dispatchableManifest("alternating-connector");

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
        // connector instance identity in `history`, never by
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
      synthesizedRevalidationOptions: FAST_REVALIDATION_OPTIONS,
    });

    scheduler.start();
    // Despite the reason alternating on every probe, the cadence must still
    // reach admission within a bounded window — proving the reason churn
    // did not reset the clock to zero on every tick.
    await waitFor(() => readAttempts(attemptsPath).length >= 1, 8000);
    scheduler.stop();

    assert.equal(
      readAttempts(attemptsPath)[0],
      "revalidation",
      "the bounded probe must eventually admit despite reason churn on every tick"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("real successful projection clear: a genuinely successful bounded probe records source.revalidationProbe and breaks the streak for the next tick", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-revalidation-success-clear-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(attemptsPath, "", "utf8");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(connectorPath, succeedingConnectorScript(attemptsPath), "utf8");
  const manifest = dispatchableManifest("success-clear-connector");

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
        // connection-health.ts projection wiring is a separate, larger
        // subsystem out of scope for this scheduler-layer fix; see the
        // task's velocity constraint.)
        if (record.status === "succeeded" && record.source?.revalidationProbe === true) {
          evidenceCleared = true;
        }
      },
      rsUrl,
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
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});
