// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorSchedulePatch, ScheduleApi, ScheduleUpsertResult } from "../runtime/controller.ts";
import type { ActivationScheduleController } from "../server/connection-activation-schedules.ts";
import {
  attachActivationScheduleIfAutomatic,
  resolveActivationRefreshContract,
} from "../server/connection-activation-schedules.ts";

function manifest(refreshPolicy: unknown) {
  return {
    capabilities: {
      refresh_policy: refreshPolicy,
    },
    connector_id: "https://registry.example.test/connectors/custom",
  };
}

interface FakeScheduleRow {
  connector_id: string;
  connector_instance_id: string;
  enabled: boolean;
  interval_seconds: number;
  jitter_seconds: number;
}

interface FakeUpsertCall {
  connectorId: string;
  input: ConnectorSchedulePatch;
  options: { connectorInstanceId?: string | null };
}

function createFakeController(initialSchedules: FakeScheduleRow[] = []): ActivationScheduleController & {
  schedules: Map<string, FakeScheduleRow>;
  upserts: FakeUpsertCall[];
} {
  const schedules = new Map(initialSchedules.map((schedule) => [schedule.connector_instance_id, schedule]));
  const upserts: FakeUpsertCall[] = [];
  return {
    getSchedule(connectorId, options = {}) {
      const key = options.connectorInstanceId || connectorId;
      const row = schedules.get(key) ?? null;
      return Promise.resolve(row as ScheduleApi | null);
    },
    schedules,
    upsertSchedule(connectorId, input, options = {}) {
      const key = options.connectorInstanceId || connectorId;
      const row: FakeScheduleRow = {
        connector_id: connectorId,
        connector_instance_id: key,
        enabled: input.enabled ?? false,
        interval_seconds: input.interval_seconds,
        jitter_seconds: input.jitter_seconds ?? 0,
      };
      upserts.push({ connectorId, input, options });
      schedules.set(key, row);
      return Promise.resolve({ policy_warning: null, schedule: row as ScheduleApi } as ScheduleUpsertResult);
    },
    upserts,
  };
}

test("6.1: automatic background-safe manifests attach a per-connection schedule at activation", async () => {
  const controller = createFakeController();
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: "custom-automatic",
    connectorInstanceId: "cin_auto_1",
    controller,
    manifest: manifest({
      background_safe: true,
      interaction_posture: "credentials",
      recommended_interval_seconds: 1800,
      recommended_mode: "automatic",
    }),
  });

  assert.equal(result.reason, "attached");
  assert.equal(result.attached, true);
  assert.equal(result.contract.mode, "automatic");
  assert.deepEqual(controller.upserts, [
    {
      connectorId: "custom-automatic",
      input: {
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 0,
      },
      options: {
        connectorInstanceId: "cin_auto_1",
      },
    },
  ]);
  const scheduleRow = controller.schedules.get("cin_auto_1");
  assert.ok(scheduleRow);
  assert.equal(scheduleRow.connector_instance_id, "cin_auto_1");
});

test("6.1: assisted automatic manifests still attach schedules; credential presence is not consulted", async () => {
  const controller = createFakeController();
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: "assisted-browser-account",
    connectorInstanceId: "cin_assisted_1",
    controller,
    manifest: manifest({
      assisted_after_owner_auth: true,
      background_safe: true,
      interaction_posture: "manual_action_likely",
      recommended_interval_seconds: 3600,
      recommended_mode: "automatic",
    }),
  });

  assert.equal(result.reason, "attached");
  assert.equal(controller.upserts.length, 1);
  const scheduleRow = controller.schedules.get("cin_assisted_1");
  assert.ok(scheduleRow);
  assert.equal(scheduleRow.interval_seconds, 3600);
});

test("6.1: activation preserves an existing schedule row instead of overwriting operator intent", async () => {
  const controller = createFakeController([
    {
      connector_id: "custom-automatic",
      connector_instance_id: "cin_existing_1",
      enabled: false,
      interval_seconds: 7200,
      jitter_seconds: 17,
    },
  ]);
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: "custom-automatic",
    connectorInstanceId: "cin_existing_1",
    controller,
    manifest: manifest({
      background_safe: true,
      recommended_interval_seconds: 1800,
      recommended_mode: "automatic",
    }),
  });

  assert.equal(result.reason, "already_attached");
  assert.equal(result.attached, false);
  assert.equal(controller.upserts.length, 0);
  const scheduleRow = controller.schedules.get("cin_existing_1");
  assert.ok(scheduleRow);
  assert.equal(scheduleRow.interval_seconds, 7200);
  assert.equal(scheduleRow.enabled, false);
});

test("6.1: manual, paused, and background-unsafe manifests do not attach schedules", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["manual", { background_safe: true, recommended_interval_seconds: 1800, recommended_mode: "manual" }],
    ["paused", { background_safe: true, recommended_interval_seconds: 1800, recommended_mode: "paused" }],
    [
      "background_unsafe",
      { background_safe: false, recommended_interval_seconds: 1800, recommended_mode: "automatic" },
    ],
  ];

  for await (const [expectedReason, policy] of cases) {
    const controller = createFakeController();
    const result = await attachActivationScheduleIfAutomatic({
      connectorId: `custom-${expectedReason}`,
      connectorInstanceId: `cin_${expectedReason}`,
      controller,
      manifest: manifest(policy),
    });

    assert.equal(result.reason, "manual_contract");
    assert.equal(result.contract.mode, "manual");
    assert.equal(result.contract.reason, expectedReason);
    assert.equal(result.attached, false);
    assert.equal(controller.upserts.length, 0);
  }
});

test("6.1: the contract resolver treats non-manual, background-safe policy as automatic", () => {
  assert.deepEqual(
    resolveActivationRefreshContract(
      manifest({
        background_safe: true,
        recommended_interval_seconds: 900,
        recommended_mode: "automatic",
      })
    ),
    {
      backgroundSafe: true,
      intervalSeconds: 900,
      mode: "automatic",
      reason: "automatic",
      recommendedMode: "automatic",
    }
  );
});
