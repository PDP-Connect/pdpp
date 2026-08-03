// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ConnectorSchedulePatch, ScheduleApi, ScheduleUpsertResult } from "../runtime/controller.ts";
import type { ActivationScheduleController } from "../server/connection-activation-schedules.ts";
import {
  attachActivationScheduleIfAutomatic,
  hasAuthenticatedRequiredStreamEvidence,
  resolveActivationRefreshContract,
} from "../server/connection-activation-schedules.ts";

function loadRealManifest(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
}

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

for (const { connectorKey, expectedIntervalSeconds } of [
  { connectorKey: "amazon", expectedIntervalSeconds: 43_200 },
  { connectorKey: "reddit", expectedIntervalSeconds: 43_200 },
  { connectorKey: "heb", expectedIntervalSeconds: 86_400 },
]) {
  test(`assisted-after-auth: the real ${connectorKey} manifest attaches an automatic schedule at post-auth activation, at its evidence-backed interval`, async () => {
    const realManifest = loadRealManifest(connectorKey);
    const controller = createFakeController();
    const result = await attachActivationScheduleIfAutomatic({
      connectorId: connectorKey,
      connectorInstanceId: `cin_${connectorKey}_1`,
      controller,
      manifest: realManifest,
    });

    assert.equal(result.reason, "attached");
    assert.equal(result.attached, true);
    assert.equal(result.contract.mode, "automatic");
    const scheduleRow = controller.schedules.get(`cin_${connectorKey}_1`);
    assert.ok(scheduleRow);
    assert.equal(scheduleRow.interval_seconds, expectedIntervalSeconds);
    assert.equal(scheduleRow.enabled, true);
  });

  test(`assisted-after-auth: activation for the real ${connectorKey} manifest never overwrites an owner-paused or owner-customized schedule row`, async () => {
    const realManifest = loadRealManifest(connectorKey);
    const controller = createFakeController([
      {
        connector_id: connectorKey,
        connector_instance_id: `cin_${connectorKey}_owner_paused`,
        enabled: false,
        interval_seconds: 999_999,
        jitter_seconds: 42,
      },
    ]);
    const result = await attachActivationScheduleIfAutomatic({
      connectorId: connectorKey,
      connectorInstanceId: `cin_${connectorKey}_owner_paused`,
      controller,
      manifest: realManifest,
    });

    assert.equal(result.reason, "already_attached");
    assert.equal(result.attached, false);
    assert.equal(controller.upserts.length, 0);
    const scheduleRow = controller.schedules.get(`cin_${connectorKey}_owner_paused`);
    assert.ok(scheduleRow);
    assert.equal(scheduleRow.enabled, false, "owner pause must survive re-activation");
    assert.equal(scheduleRow.interval_seconds, 999_999, "owner custom interval must survive re-activation");
    assert.equal(scheduleRow.jitter_seconds, 42, "owner custom jitter must survive re-activation");
  });
}

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

function manifestWithStreams(streams: Array<{ name: string; required?: boolean }>): unknown {
  return { streams };
}

const AMAZON_MANIFEST = manifestWithStreams([{ name: "orders" }, { name: "order_items" }]);

test("hasAuthenticatedRequiredStreamEvidence: no terminal data is never evidence", () => {
  assert.equal(hasAuthenticatedRequiredStreamEvidence(undefined, AMAZON_MANIFEST), false);
  assert.equal(hasAuthenticatedRequiredStreamEvidence(null, AMAZON_MANIFEST), false);
  assert.equal(hasAuthenticatedRequiredStreamEvidence({}, AMAZON_MANIFEST), false);
});

test("hasAuthenticatedRequiredStreamEvidence: a manifest with no declared streams never proves evidence", () => {
  const terminalData = { collection_facts: { streams: [{ considered: 0, stream: "orders" }] } };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, {}), false);
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, { streams: [] }), false);
});

test("hasAuthenticatedRequiredStreamEvidence: a required stream with considered=0 after a completed pass is proof (zero-record success)", () => {
  const terminalData = { collection_facts: { streams: [{ checkpoint: "not_staged", considered: 0, stream: "orders" }] } };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, AMAZON_MANIFEST), true);
});

test("hasAuthenticatedRequiredStreamEvidence: a required stream with a committed/not_committed checkpoint is proof", () => {
  for (const checkpoint of ["committed", "not_committed", "disabled"]) {
    const terminalData = { collection_facts: { streams: [{ checkpoint, stream: "orders" }] } };
    assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, AMAZON_MANIFEST), true, `checkpoint=${checkpoint}`);
  }
});

test("hasAuthenticatedRequiredStreamEvidence: a required stream that is only not_staged with no declared considered is NOT proof (unauthenticated/failed-before-fetch)", () => {
  const terminalData = { collection_facts: { streams: [{ checkpoint: "not_staged", stream: "orders" }] } };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, AMAZON_MANIFEST), false);
});

test("hasAuthenticatedRequiredStreamEvidence: an optional (required:false) stream's evidence does not count", () => {
  const manifestWithOptional = manifestWithStreams([{ name: "orders" }, { name: "reviews", required: false }]);
  const terminalData = { collection_facts: { streams: [{ considered: 3, stream: "reviews" }] } };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, manifestWithOptional), false);
});

test("hasAuthenticatedRequiredStreamEvidence: an unrelated/unknown stream name's evidence does not count", () => {
  const terminalData = { collection_facts: { streams: [{ considered: 3, stream: "totally_unrelated_stream" }] } };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, AMAZON_MANIFEST), false);
});

test("hasAuthenticatedRequiredStreamEvidence: a recovery-only run is never proof even with strong per-stream facts", () => {
  const terminalData = {
    collection_facts: { streams: [{ checkpoint: "committed", considered: 5, stream: "orders" }] },
    recovery_only: true,
  };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, AMAZON_MANIFEST), false);
});

test("hasAuthenticatedRequiredStreamEvidence: an empty collection_facts.streams array is never proof", () => {
  assert.equal(hasAuthenticatedRequiredStreamEvidence({ collection_facts: { streams: [] } }, AMAZON_MANIFEST), false);
});

test("hasAuthenticatedRequiredStreamEvidence: one proven required stream among several unproven/optional/unrelated entries is still sufficient", () => {
  const manifestWithOptional = manifestWithStreams([
    { name: "orders" },
    { name: "order_items" },
    { name: "reviews", required: false },
  ]);
  const terminalData = {
    collection_facts: {
      streams: [
        { checkpoint: "not_staged", stream: "order_items" },
        { considered: 9, stream: "reviews" },
        { considered: 0, stream: "totally_unrelated_stream" },
        { considered: 0, stream: "orders" },
      ],
    },
  };
  assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, manifestWithOptional), true);
});

for (const connectorKey of ["amazon", "reddit", "heb"]) {
  test(`hasAuthenticatedRequiredStreamEvidence: real ${connectorKey} manifest — zero-record authenticated success is proof`, () => {
    const realManifest = loadRealManifest(connectorKey) as { streams: Array<{ name: string }> };
    const primaryStream = realManifest.streams[0]?.name;
    assert.ok(primaryStream, `${connectorKey} manifest must declare at least one stream`);
    const terminalData = { collection_facts: { streams: [{ considered: 0, stream: primaryStream }] } };
    assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, realManifest), true);
  });

  test(`hasAuthenticatedRequiredStreamEvidence: real ${connectorKey} manifest — a run with no collection_facts (auth-failed-before-fetch) is not proof`, () => {
    const realManifest = loadRealManifest(connectorKey);
    assert.equal(hasAuthenticatedRequiredStreamEvidence({}, realManifest), false);
    assert.equal(hasAuthenticatedRequiredStreamEvidence({ connector_error: { code: "credential_rejected" } }, realManifest), false);
  });

  test(`hasAuthenticatedRequiredStreamEvidence: real ${connectorKey} manifest — a recovery-only run is not proof`, () => {
    const realManifest = loadRealManifest(connectorKey) as { streams: Array<{ name: string }> };
    const primaryStream = realManifest.streams[0]?.name;
    const terminalData = {
      collection_facts: { streams: [{ considered: 0, stream: primaryStream }] },
      recovery_only: true,
    };
    assert.equal(hasAuthenticatedRequiredStreamEvidence(terminalData, realManifest), false);
  });
}
