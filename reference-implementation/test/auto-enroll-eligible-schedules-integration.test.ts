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
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";

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
