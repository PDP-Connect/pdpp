// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-enrollment must key its schedule row to the owner's REAL connection
 * (`cin_...`), not to the bare connector id.
 *
 * Production defect (2026-08-25, owner instance): nine `connector_schedules`
 * rows were keyed by a bare connector id — `reddit`, `notion`, `jellyfin`,
 * `steam`, `groupme`, `apple_contacts`, `claude-code`, `codex`, `signal` —
 * because `autoEnrollEligibleSchedules` calls `controller.upsertSchedule(
 * connectorId, ...)` with no `connectorInstanceId`, and `upsertSchedule`
 * falls back to `options.connectorInstanceId || resolvedConnectorId`
 * (`runtime/controller.ts`). The row is therefore written under a key that
 * matches no `connector_instances` row.
 *
 * Two owner-visible consequences, both observed live:
 *
 *   1. The scheduler dispatches the orphan, and `admitOwnerRunConnection`
 *      rejects it with `connector_instance_not_found` — swallowed at
 *      `logger.debug` as "connection no longer exists", which is false: the
 *      connection exists, the schedule key is wrong. The connection never
 *      refreshes.
 *   2. Every later boot re-reads the orphan, counts it `skipped_existing`,
 *      and never repairs it. The live boot log showed
 *      `enrolled: 0, skipped_existing: 15`.
 *
 * Six owner rows (Apple Contacts, ChatGPT, Jellyfin, Notion, Reddit, Steam)
 * rendered amber "Needs refresh" with EVERY other health axis green — stale
 * only because nothing ever ran them.
 *
 * Spec: openspec/changes/auto-enroll-eligible-connector-schedules/.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { registerConnector } from "../server/auth.ts";
import {
  type AutoEnrollListConnectors,
  autoEnrollEligibleSchedules,
} from "../server/auto-enroll-eligible-schedules.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";

const TEST_ENV_KEY = "TEST_AUTO_ENROLL_INSTANCE_KEY_TOKEN";
const OWNER_SUBJECT_ID = "owner-under-test";

function testManifest(): Record<string, unknown> {
  return {
    capabilities: {
      auth: { kind: "env", required: [TEST_ENV_KEY] },
      public_listing: { tier: "supported" },
      refresh_policy: {
        background_safe: true,
        interaction_posture: "none",
        rationale: "Synthetic manifest for the schedule-instance-key contract.",
        recommended_interval_seconds: 3600,
        recommended_mode: "automatic",
      },
    },
    connector_id: "https://registry.pdpp.dev/connectors/test-auto-enroll-instance-key",
    display_name: "Test auto-enroll instance key",
    manifest_uri: "https://registry.pdpp.dev/connectors/test-auto-enroll-instance-key",
    protocol_version: "0.1.0",
    runtime_requirements: {},
    streams: [
      {
        name: "records",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-auto-enroll-instance-key-"));
    initDb(join(dir, "pdpp.sqlite"));
    __resetControllerInteractionStateForTests();
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function buildListConnectors(manifest: Record<string, unknown>): AutoEnrollListConnectors {
  return async () => [{ connector_id: manifest.connector_id as string, manifest }];
}

test(
  "auto-enrollment keys the schedule to the owner's connection, not the bare connector id",
  withTmpDb(async () => {
    const manifest = testManifest();
    const registryId = manifest.connector_id as string;
    await registerConnector(manifest);
    const canonicalId = canonicalConnectorKey(registryId) ?? registryId;

    // The owner already has exactly ONE real connection for this connector —
    // the shape every non-green production row had.
    const connectorInstanceId = "cin_autoenrollinstancekeytest";
    const instanceStore = createSqliteConnectorInstanceStore();
    await Promise.resolve(
      instanceStore.upsert({
        connectorId: canonicalId,
        connectorInstanceId,
        createdAt: new Date().toISOString(),
        displayName: "Owner connection under test",
        ownerSubjectId: OWNER_SUBJECT_ID,
        revokedAt: null,
        sourceBinding: { kind: "test" },
        sourceBindingKey: "test-binding-key",
        sourceKind: "account",
        status: "active",
        updatedAt: new Date().toISOString(),
      })
    );

    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { [TEST_ENV_KEY]: "integration-token" },
      listActiveConnectorInstanceIds: async (id) => {
        const instances = await Promise.resolve(
          instanceStore.listActiveByConnector(OWNER_SUBJECT_ID, canonicalConnectorKey(id) ?? id)
        );
        return instances.map((instance) => instance.connectorInstanceId);
      },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.enrolled, 1, JSON.stringify(summary));
    assert.equal(summary.errors, 0, JSON.stringify(summary));

    const persistedRows = await Promise.resolve(getDefaultSchedulerStore().listSchedules());
    const rowsForConnector = persistedRows.filter((row) => row.connector_id === canonicalId);
    assert.equal(rowsForConnector.length, 1, "exactly one schedule row for this connector");

    // The regression: the row must be reachable from the owner's connection.
    // Keyed by the bare connector id it is an orphan — the scheduler dispatches
    // it, admission raises connector_instance_not_found, and the connection
    // silently never refreshes.
    assert.equal(
      rowsForConnector[0]?.connector_instance_id,
      connectorInstanceId,
      `schedule row is keyed by '${rowsForConnector[0]?.connector_instance_id}', which matches no connector_instances row; the owner's connection '${connectorInstanceId}' therefore never runs`
    );
  })
);
