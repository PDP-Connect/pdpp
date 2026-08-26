// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the auto-enrollment helper against the real
 * reference controller and scheduler store.
 *
 * Proves the helper hooks into:
 *   - the real `createController().upsertSchedule` path (which goes
 *     through the eligibility gate and the scheduler store);
 *   - real first-party manifests on disk (Notion, Oura, Strava all carry
 *     `capabilities.auth.required` after the manifest declaration slice);
 *   - the doctor's catalog cross-reference, so an enrolled row stops
 *     showing up as `NOSCHED`.
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

const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-08-16T00:00:00.000Z";

// `connector_instances.connector_id` has a `FOREIGN KEY ... REFERENCES
// connectors(connector_id)` constraint, so a connector must be registered
// before an instance can reference it. Registers a minimal manifest under a
// synthetic registry slug and returns the canonical key `registerConnector`
// stored it under (matching how `canonicalConnectorKey` derives short keys
// from `https://registry.pdpp.dev/connectors/<slug>` in production).
async function registerConnectorWithKey(slug: string): Promise<string> {
  const manifest = {
    capabilities: {
      auth: { kind: "env", required: [] },
      public_listing: { tier: "supported" },
      refresh_policy: {
        background_safe: true,
        interaction_posture: "none",
        rationale: "Synthetic manifest for the getSchedule active-connection filter contract.",
        recommended_interval_seconds: 3600,
        recommended_mode: "automatic",
      },
    },
    connector_id: `https://registry.pdpp.dev/connectors/${slug}`,
    display_name: slug,
    manifest_uri: `https://registry.pdpp.dev/connectors/${slug}`,
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
  const connectorId = await registerConnector(manifest);
  return canonicalConnectorKey(connectorId) ?? connectorId;
}

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  sourceBindingKey: string;
}

// Seeds a real, active `connector_instances` row so `getSchedule`'s
// active-connection filter has something authoritative to check.
async function seedInstance({
  connectorId,
  connectorInstanceId,
  sourceBindingKey,
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: sourceBindingKey,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

interface SeedScheduleOptions {
  connectorId: string;
  connectorInstanceId: string;
}

// Seeds a schedule row keyed by `connector_instance_id`, same as a real
// per-connection schedule created by `upsertSchedule`/activation — done
// directly against the store so a test can create two schedule rows for one
// connector_id without going through `getSchedule`'s own ambiguity guard.
async function seedSchedule({ connectorId, connectorInstanceId }: SeedScheduleOptions): Promise<void> {
  const store = getDefaultSchedulerStore();
  await Promise.resolve(
    store.createSchedule({
      connector_id: connectorId,
      connector_instance_id: connectorInstanceId,
      created_at: NOW,
      enabled: true,
      interval_seconds: 3600,
      jitter_seconds: 0,
      updated_at: NOW,
    })
  );
}

const TEST_ENV_KEY = "TEST_AUTO_ENROLL_TOKEN";

function testManifest(recommendedMode: "automatic" | "manual" = "automatic"): Record<string, unknown> {
  return {
    capabilities: {
      auth: { kind: "env", required: [TEST_ENV_KEY] },
      public_listing: { tier: "supported" },
      // Mode is DERIVED from these facts, so the synthetic manifest has to
      // declare a coherent pair rather than just asserting a mode string:
      // the manual variant is an interactive-login connector that has not
      // declared session persistence (the Chase/USAA shape), and the
      // automatic variant needs no per-run owner gesture.
      refresh_policy: {
        background_safe: recommendedMode === "automatic",
        interaction_posture: recommendedMode === "automatic" ? "none" : "otp_likely",
        rationale: "Synthetic manifest for the scheduler integration contract.",
        recommended_interval_seconds: 3600,
        recommended_mode: recommendedMode,
      },
    },
    connector_id: `https://registry.pdpp.dev/connectors/test-auto-enroll-${recommendedMode}`,
    display_name: `Test auto-enroll (${recommendedMode})`,
    manifest_uri: `https://registry.pdpp.dev/connectors/test-auto-enroll-${recommendedMode}`,
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
    const dir = mkdtempSync(join(tmpdir(), "pdpp-auto-enroll-int-"));
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
  "enrollment against a real controller creates a single enabled row for an eligible registered manifest",
  withTmpDb(async () => {
    const manifest = testManifest();
    const connectorId = manifest.connector_id as string;
    await registerConnector(manifest);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { [TEST_ENV_KEY]: "integration-token" },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.enrolled, 1, JSON.stringify(summary));
    assert.equal(summary.errors, 0);
    const schedule = await controller.getSchedule(connectorId);
    assert.ok(schedule, "a schedule row exists for the eligible connector");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.interval_seconds, 3600);
    assert.equal(schedule.ineligibility_reason, null, "eligible under current manifest");
    // Pin the persisted store too: the row went through createSchedule().
    // The store key is the canonical short key, not the registry URI.
    const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
    const persisted = await Promise.resolve(getDefaultSchedulerStore().getSchedule(canonicalId));
    assert.ok(persisted, "persisted schedule row should exist under the canonical key");
    assert.equal(persisted.enabled, true);
  })
);

test(
  "enrollment leaves a connector unscheduled when its declared env is missing",
  withTmpDb(async () => {
    const manifest = testManifest();
    const connectorId = manifest.connector_id as string;
    await registerConnector(manifest);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: {
        /* TEST_AUTO_ENROLL_TOKEN intentionally absent */
      },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.skipped_env, 1);
    assert.equal(summary.enrolled, 0);
    const schedule = await controller.getSchedule(connectorId);
    assert.equal(schedule, null, "no row created when env is missing");
  })
);

test(
  "enrollment never overrides an operator-paused row across boots",
  withTmpDb(async () => {
    const manifest = testManifest();
    const connectorId = manifest.connector_id as string;
    await registerConnector(manifest);
    const controller = createController({});
    // Operator already created a paused row with a custom interval.
    await controller.upsertSchedule(connectorId, {
      enabled: false,
      interval_seconds: 1800,
      jitter_seconds: 30,
    });
    const beforeRow = await controller.getSchedule(connectorId);
    assert.ok(beforeRow, "operator-created row should exist before enrollment runs");
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { [TEST_ENV_KEY]: "integration-token" },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.skipped_existing, 1);
    assert.equal(summary.enrolled, 0);
    const afterRow = await controller.getSchedule(connectorId);
    assert.ok(afterRow, "row should still exist after enrollment runs");
    assert.equal(afterRow.enabled, false, "paused row stays paused");
    assert.equal(afterRow.interval_seconds, beforeRow.interval_seconds);
    assert.equal(afterRow.jitter_seconds, beforeRow.jitter_seconds);
  })
);

test(
  "enrollment is a no-op for connectors whose manifest is manual or background-unsafe",
  withTmpDb(async () => {
    const manifest = testManifest("manual");
    const connectorId = manifest.connector_id as string;
    await registerConnector(manifest);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { [TEST_ENV_KEY]: "integration-token" },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.skipped_policy, 1);
    assert.equal(summary.enrolled, 0);
    const schedule = await controller.getSchedule(connectorId);
    assert.equal(schedule, null);
  })
);

test(
  "a manual-default manifest does not auto-enroll but accepts an explicit owner schedule",
  withTmpDb(async () => {
    const manifest = testManifest("manual");
    const connectorId = manifest.connector_id as string;
    await registerConnector(manifest);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { [TEST_ENV_KEY]: "integration-token" },
      listConnectors: buildListConnectors(manifest),
    });
    assert.equal(summary.enrolled, 0, "manual-default connectors never auto-enroll on boot");
    assert.equal(await controller.getSchedule(connectorId), null);

    const result = await controller.upsertSchedule(connectorId, {
      enabled: true,
      interval_seconds: 21_600,
    });
    assert.equal(result.schedule.enabled, true);
    assert.equal(result.schedule.ineligibility_reason ?? null, null);
    const schedule = await controller.getSchedule(connectorId);
    assert.ok(schedule, "explicit owner schedule should be persisted");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.interval_seconds, 21_600);
  })
);

// Reproduces the live-production defect: `getSchedule`'s bare-connector-id
// lookup path (no `connector_instance_id` given, e.g. the auto-enroll caller)
// counted every schedule row for a connector_id, including rows whose
// connector_instance_id names a connection that no longer exists at all.
// `connector_schedules` carries no foreign key to `connector_instances` (see
// `CREATE TABLE connector_schedules` in `server/db.ts`), so a schedule row can
// outlive its connection with nothing enforcing referential cleanup — exactly
// the live shape: one connector_instances row backing amazon's live
// connection, plus a second amazon schedule row whose connector_instance_id
// has NO connector_instances row at all (an orphaned fragment). One live
// connection plus that orphaned schedule row was misreported as ambiguous,
// and the connector became silently unschedulable (`[auto-enroll] getSchedule
// failed for amazon: ambiguous_connector_instance`). `getSchedule` must count
// only schedules whose connection is still active.
test(
  "getSchedule resolves the single active connection's schedule when a second schedule row names a connection that no longer exists (amazon shape)",
  withTmpDb(async () => {
    const connectorId = await registerConnectorWithKey("test-auto-enroll-amazon-shape");
    const activeInstanceId = "cin_5b8b839dde239f15c325c04d";
    const orphanedInstanceId = "cin_cd523fe54af1881cc18d7368";
    await seedInstance({ connectorId, connectorInstanceId: activeInstanceId, sourceBindingKey: "live" });
    // No `seedInstance` call for `orphanedInstanceId`: production's "NO
    // CONNECTION (orphaned fragment)" shape is a schedule row with zero
    // matching connector_instances rows, not merely a revoked one.
    await seedSchedule({ connectorId, connectorInstanceId: activeInstanceId });
    await seedSchedule({ connectorId, connectorInstanceId: orphanedInstanceId });

    const controller = createController({});
    const schedule = await controller.getSchedule(connectorId);
    assert.ok(schedule, "the single active connection's schedule should resolve without throwing");
    assert.equal(schedule.connector_instance_id, activeInstanceId);
  })
);

// Companion negative case: two connections that are BOTH genuinely active is
// real ambiguity (the pr89 exactly-one-guard principle — never resolve
// ambiguity by implicit fallback), so `getSchedule` must still throw here.
// This must pass before AND after the fix above; if it stops throwing, the
// active-connection filter has been widened into "pick one" and the guard is
// broken.
test(
  "getSchedule still throws ambiguous_connector_instance when two connections are both active (heb shape)",
  withTmpDb(async () => {
    const connectorId = await registerConnectorWithKey("test-auto-enroll-heb-shape");
    const firstInstanceId = "cin_8997c14400adc5ddba7b36a8";
    const secondInstanceId = "cin_c875ca3ec8b6ce2c283a4288";
    await seedInstance({ connectorId, connectorInstanceId: firstInstanceId, sourceBindingKey: "account-1" });
    await seedInstance({ connectorId, connectorInstanceId: secondInstanceId, sourceBindingKey: "account-2" });
    await seedSchedule({ connectorId, connectorInstanceId: firstInstanceId });
    await seedSchedule({ connectorId, connectorInstanceId: secondInstanceId });

    const controller = createController({});
    await assert.rejects(
      () => controller.getSchedule(connectorId),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "ambiguous_connector_instance"
    );
  })
);
