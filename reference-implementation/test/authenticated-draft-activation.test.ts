// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves the systemic fix for the "authenticated zero-record first collection
// stays an invisible draft forever" gap: a draft static-secret connection
// (Amazon/Reddit/H-E-B) whose first run genuinely authenticates and completes
// a pass over a manifest-declared required stream activates even when it
// emitted zero records — but never from terminal status:"succeeded" alone,
// never for a failed/cancelled run, never for a recovery-only run, and never
// when the only evidence touches a stream the manifest does not require.
//
// Exercises the REAL controller.runNow → the new
// activateDraftConnectionOnAuthenticatedSuccess hook → the REAL
// connector-instance store's activateDraft, with a REAL terminal spine event
// (emitted the same way runtime/index.ts's real runConnector would) so
// hasAuthenticatedRequiredStreamEvidence reads real, not test-fabricated,
// evidence shape.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import { emitSpineEvent, setCurrentBootEpoch } from "../lib/spine.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const AMAZON_MANIFEST = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../../packages/polyfill-connectors/manifests/amazon.json", import.meta.url), "utf8")
);

function freshDb(t: TestContext): void {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-authenticated-draft-activation-"));
  __resetControllerInteractionStateForTests();
  setCurrentBootEpoch({ boot_epoch: "00000000-0000-4000-8000-000000000001", controller_id: "test-controller", seq: 1 });
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function seedDraftConnectorInstance({
  connectorInstanceId,
  ownerSubjectId,
  connectorId,
}: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  connectorId: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'draft', 'account', ?, ?, ?, ?, NULL)`
  ).run(
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    JSON.stringify({ kind: "static_secret_draft" }),
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z"
  );
}

function instanceStatus(connectorInstanceId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT status FROM connector_instances WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { status: string } | undefined;
  return row?.status ?? null;
}

function scheduleRow(connectorInstanceId: string): { enabled: number; interval_seconds: number } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT enabled, interval_seconds FROM connector_schedules WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { enabled: number; interval_seconds: number } | undefined;
  return row ?? null;
}

/** Emits run.started then a terminal event, mirroring the real shape runtime/index.ts produces. */
async function emitRunLifecycle({
  connectorId,
  connectorInstanceId,
  runId,
  terminalEventType,
  terminalData,
}: {
  connectorId: string;
  connectorInstanceId: string;
  runId: string;
  terminalEventType: "run.cancelled" | "run.completed" | "run.failed";
  terminalData?: Record<string, unknown>;
}): Promise<void> {
  const base = {
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
    source: { id: connectorId, kind: "connector" as const },
  };
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: { ...base, boot_epoch: "00000000-0000-4000-8000-000000000001", seq: 1 },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    source_id: connectorId,
    source_kind: "connector",
    status: "started",
    trace_id: `trc_${runId}`,
  });
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: { ...base, ...terminalData },
    event_type: terminalEventType,
    object_id: runId,
    object_type: "run",
    run_id: runId,
    source_id: connectorId,
    source_kind: "connector",
    status: terminalEventType === "run.completed" ? "succeeded" : "failed",
    trace_id: `trc_${runId}`,
  });
}

function makeController(
  runConnectorImpl: (opts: RuntimeRunConnectorOptions) => Promise<RuntimeRunConnectorResult>
) {
  return createController({
    activateDraftConnectionOnAuthenticatedSuccess: ({ connectorInstanceId }) => {
      createSqliteConnectorInstanceStore().activateDraft(connectorInstanceId);
      return Promise.resolve();
    },
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? "cin_missing",
        ownerSubjectId: ownerSubjectId ?? "owner_1",
      }),
    connectorPathResolver: () => "/tmp/connector.ts",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    resolveStaticSecretRunEnv: () =>
      Promise.resolve({ AMAZON_PASSWORD: "test-password", AMAZON_USERNAME: "test-user@example.com" }),
    runConnectorImpl,
  });
}

test("a zero-record but genuinely authenticated first run activates a draft Amazon connection and attaches its schedule", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({ connectorId: "amazon", connectorInstanceId: "cin_amazon_fresh", ownerSubjectId: "owner_1" });
  assert.equal(instanceStatus("cin_amazon_fresh"), "draft");

  const runId = "run_amazon_zero_record_success";
  const controller = makeController(async () => {
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_fresh",
      runId,
      terminalData: { collection_facts: { streams: [{ considered: 0, stream: "orders" }] } },
      terminalEventType: "run.completed",
    });
    return { records_emitted: 0, status: "succeeded" };
  });

  await controller.runNow("amazon", { connectorInstanceId: "cin_amazon_fresh", manifest: AMAZON_MANIFEST, ownerToken: "t", runId });
  await controller.drainActiveRuns(1000);

  assert.equal(instanceStatus("cin_amazon_fresh"), "active", "a genuinely authenticated zero-record run must activate the draft");
  const schedule = scheduleRow("cin_amazon_fresh");
  assert.ok(schedule, "activation must attach a schedule for an automatic assisted-after-auth manifest");
  assert.equal(schedule.enabled, 1);
  assert.equal(schedule.interval_seconds, 43_200);
});

test("terminal status:succeeded ALONE (no collection_facts) never activates a draft", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({ connectorId: "amazon", connectorInstanceId: "cin_amazon_claimed", ownerSubjectId: "owner_1" });

  const runId = "run_amazon_claimed_success_no_evidence";
  const controller = makeController(async () => {
    // A run that reports terminal success but never emitted any
    // collection_facts (e.g. a compromised/misbehaving connector, or a
    // process that raced past the terminal builder) must not activate the
    // draft on status alone.
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_claimed",
      runId,
      terminalEventType: "run.completed",
    });
    return { records_emitted: 0, status: "succeeded" };
  });

  await controller.runNow("amazon", { connectorInstanceId: "cin_amazon_claimed", manifest: AMAZON_MANIFEST, ownerToken: "t", runId });
  await controller.drainActiveRuns(1000);

  assert.equal(instanceStatus("cin_amazon_claimed"), "draft", "claimed success with no real evidence must not activate");
  assert.equal(scheduleRow("cin_amazon_claimed"), null);
});

test("a failed run (credential rejected before any stream) never activates a draft", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({ connectorId: "amazon", connectorInstanceId: "cin_amazon_failed", ownerSubjectId: "owner_1" });

  const runId = "run_amazon_credential_rejected";
  const controller = makeController(async () => {
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_failed",
      runId,
      terminalEventType: "run.failed",
    });
    return {
      connector_error: { code: "credential_rejected", message: "provider rejected stored credential", retryable: false },
      records_emitted: 0,
      status: "failed",
    };
  });

  await controller.runNow("amazon", { connectorInstanceId: "cin_amazon_failed", manifest: AMAZON_MANIFEST, ownerToken: "t", runId });
  await controller.drainActiveRuns(1000);

  assert.equal(instanceStatus("cin_amazon_failed"), "draft", "a failed/unauthenticated run must not activate the draft");
  assert.equal(scheduleRow("cin_amazon_failed"), null);
});

test("a recovery-only run's terminal evidence never activates a draft", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({ connectorId: "amazon", connectorInstanceId: "cin_amazon_recovery", ownerSubjectId: "owner_1" });

  const runId = "run_amazon_recovery_only";
  const controller = makeController(async () => {
    // recovery_only:true carries collection_facts-shaped evidence on the
    // required stream, but a recovery-only pass performs no forward/list-pass
    // inventory scan by definition — it must never count as first-collection
    // proof.
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_recovery",
      runId,
      terminalData: {
        collection_facts: { streams: [{ checkpoint: "committed", considered: 5, stream: "orders" }] },
        recovery_only: true,
      },
      terminalEventType: "run.completed",
    });
    return { records_emitted: 0, status: "succeeded" };
  });

  await controller.runNow("amazon", { connectorInstanceId: "cin_amazon_recovery", manifest: AMAZON_MANIFEST, ownerToken: "t", runId });
  await controller.drainActiveRuns(1000);

  assert.equal(instanceStatus("cin_amazon_recovery"), "draft", "a recovery-only run must not activate the draft");
});

test("evidence for an unrelated/non-required stream never activates a draft", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({ connectorId: "amazon", connectorInstanceId: "cin_amazon_unrelated_stream", ownerSubjectId: "owner_1" });

  const runId = "run_amazon_unrelated_stream_only";
  const controller = makeController(async () => {
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_unrelated_stream",
      runId,
      terminalData: { collection_facts: { streams: [{ considered: 3, stream: "not_a_declared_stream" }] } },
      terminalEventType: "run.completed",
    });
    return { records_emitted: 0, status: "succeeded" };
  });

  await controller.runNow("amazon", {
    connectorInstanceId: "cin_amazon_unrelated_stream",
    manifest: AMAZON_MANIFEST,
    ownerToken: "t",
    runId,
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    instanceStatus("cin_amazon_unrelated_stream"),
    "draft",
    "evidence for a stream the manifest does not declare as required must not activate the draft"
  );
});

test("this activation path is idempotent and never overwrites an owner-paused or custom schedule that already exists", async (t) => {
  freshDb(t);
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstance({
    connectorId: "amazon",
    connectorInstanceId: "cin_amazon_already_active",
    ownerSubjectId: "owner_1",
  });
  // Simulate the connection having already been activated by an earlier
  // records-ingest run, with the owner then pausing and customizing it.
  createSqliteConnectorInstanceStore().activateDraft("cin_amazon_already_active");
  const db = getDb();
  db.prepare(
    `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
     VALUES (?, 'amazon', 999999, 42, 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  ).run("cin_amazon_already_active");

  const runId = "run_amazon_already_active_second_success";
  const controller = makeController(async () => {
    await emitRunLifecycle({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_already_active",
      runId,
      terminalData: { collection_facts: { streams: [{ considered: 2, stream: "orders" }] } },
      terminalEventType: "run.completed",
    });
    return { records_emitted: 2, status: "succeeded" };
  });

  await controller.runNow("amazon", {
    connectorInstanceId: "cin_amazon_already_active",
    manifest: AMAZON_MANIFEST,
    ownerToken: "t",
    runId,
  });
  await controller.drainActiveRuns(1000);

  assert.equal(instanceStatus("cin_amazon_already_active"), "active");
  const schedule = scheduleRow("cin_amazon_already_active");
  assert.ok(schedule);
  assert.equal(schedule.enabled, 0, "owner pause must survive a later authenticated success");
  assert.equal(schedule.interval_seconds, 999_999, "owner custom interval must survive a later authenticated success");
});
