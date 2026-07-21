// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { CLAUDE_CODE_CONNECTOR_ID, transformRecordsToLocalDeviceEnvelopes } from "../../src/local-device-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Multi-device binding coverage for the Claude Code local collector
 * (complete-local-agent-collectors tasks 3.1, 3.2, 3.4).
 *
 * Both committed fixture homes own a skill named `demo-skill`
 * (`skills/demo-skill/SKILL.md`), so the connector emits the SAME
 * connector-local record key — `skills:demo-skill` — for both source homes.
 * That collision is intentional: connector-local keys are NOT globally
 * unique, and two devices/source homes legitimately share names.
 *
 * Isolation is the device-envelope layer's job, not the connector's. Each
 * source home binds to a connector instance via a distinct
 * `source_instance_id` (and, downstream, `connector_instance_id`), and the
 * reference store keys records by `(connector_instance_id, stream,
 * record_key)`. These tests prove:
 *
 *   1. Both homes really do emit the same `skills:demo-skill` key (the
 *      collision surface is real, not hypothetical).
 *   2. Wrapping each home's records under its own source-instance identity
 *      produces envelopes that stay distinct on `(source_instance_id,
 *      record_key)` even though `record_key` is identical — so a downstream
 *      store keyed by source/connector instance never overwrites one home
 *      with the other.
 *
 * The end-to-end storage proof (two enrolled instances, two rows for the same
 * record_key) lives in the reference-implementation device-exporter route
 * suite; this suite proves the connector + envelope half on the collector
 * side without standing up a server.
 */

const FIXTURE_ROOT = join(import.meta.dirname, "../../fixtures/claude_code/source-home");
const DEVICE_A_HOME = join(FIXTURE_ROOT, "deviceA/claude-home");
const DEVICE_B_HOME = join(FIXTURE_ROOT, "deviceB/claude-home");

const SHARED_SKILL_KEY = "skills:demo-skill";

function records(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
}

async function collectSkills(home: string): Promise<Extract<EmittedMessage, { type: "RECORD" }>[]> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: {
      CLAUDE_CODE_HOME: home,
      CLAUDE_CODE_PROJECTS_DIR: join(home, "projects"),
    },
    start: { scope: { streams: [{ name: "skills" }] }, type: "START" },
  });
  assert.equal(result.code, 0);
  return records(result.messages).filter((r) => r.stream === "skills");
}

test("claude-code: two source homes emit the SAME connector-local skill key", async () => {
  const [aSkills, bSkills] = await Promise.all([collectSkills(DEVICE_A_HOME), collectSkills(DEVICE_B_HOME)]);

  const aShared = aSkills.find((r) => r.key === SHARED_SKILL_KEY);
  const bShared = bSkills.find((r) => r.key === SHARED_SKILL_KEY);
  assert.ok(aShared, "device A must emit the shared demo-skill key");
  assert.ok(bShared, "device B must emit the shared demo-skill key");

  // The collision surface is real: the connector-local key is identical
  // across homes. Without instance namespacing, these would overwrite.
  assert.equal(aShared.key, bShared.key);
  assert.equal(aShared.data.id, bShared.data.id);
});

test("claude-code: per-source-home envelopes stay isolated despite identical record keys", async () => {
  const [aSkills, bSkills] = await Promise.all([collectSkills(DEVICE_A_HOME), collectSkills(DEVICE_B_HOME)]);

  // Bind each source home to its own connector instance. Two enrolled source
  // homes for the same owner + connector type get distinct
  // source_instance_id / device_id values; the envelope carries that identity
  // alongside the (non-unique) connector-local record key.
  const aEnvelopes = transformRecordsToLocalDeviceEnvelopes({
    batchId: "batch-a",
    batchSeq: 1,
    connectorId: CLAUDE_CODE_CONNECTOR_ID,
    deviceId: "device-a",
    messages: aSkills,
    sourceInstanceId: "source-home-a",
  });
  const bEnvelopes = transformRecordsToLocalDeviceEnvelopes({
    batchId: "batch-b",
    batchSeq: 1,
    connectorId: CLAUDE_CODE_CONNECTOR_ID,
    deviceId: "device-b",
    messages: bSkills,
    sourceInstanceId: "source-home-b",
  });

  const aShared = aEnvelopes.find((e) => e.record_key === SHARED_SKILL_KEY);
  const bShared = bEnvelopes.find((e) => e.record_key === SHARED_SKILL_KEY);
  assert.ok(aShared && bShared, "both homes must produce an envelope for the shared skill key");

  // Envelopes are tagged with the correct connector + per-home identity.
  assert.equal(aShared.connector_id, CLAUDE_CODE_CONNECTOR_ID);
  assert.equal(bShared.connector_id, CLAUDE_CODE_CONNECTOR_ID);
  assert.equal(aShared.record_key, bShared.record_key, "record key collision is expected");

  // The isolation key — what a downstream store would dedup on — must differ.
  assert.notEqual(aShared.source_instance_id, bShared.source_instance_id);
  assert.notEqual(aShared.device_id, bShared.device_id);

  // Modeling the store's dedup key as (source_instance_id, stream,
  // record_key): two homes sharing a record_key still occupy two distinct
  // slots, so neither overwrites the other.
  const dedupKey = (e: { source_instance_id: string; stream: string; record_key: string }): string =>
    JSON.stringify([e.source_instance_id, e.stream, e.record_key]);
  const slots = new Set([dedupKey(aShared), dedupKey(bShared)]);
  assert.equal(slots.size, 2, "shared record key must map to two distinct per-instance slots");

  // The two homes also carry distinct skill BODIES; isolation must not be a
  // dedup that silently drops device B's content.
  assert.notEqual(
    JSON.stringify(aShared.data),
    JSON.stringify(bShared.data),
    "device B's demo-skill body must survive alongside device A's"
  );
  assert.ok(JSON.stringify(bShared.data).includes("Device B"), "device B body must be preserved");
});
