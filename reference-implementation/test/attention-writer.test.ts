// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for runtime/attention-writer.ts — the production writer that
 * closes the `complete-ri-operator-console-reliability` task 5.3 gap by
 * persisting structured attention rows as INTERACTION/ASSISTANCE
 * messages flow through `runConnector`.
 *
 * Two layers:
 *
 *   1. Unit tests against a fake in-memory store, exercising:
 *        - INTERACTION upsert -> open row with non-secret action_target
 *        - secret-sensitive INTERACTION (credentials/otp) persists with
 *          `sensitivity: "secret"` and never leaks the submitted value
 *          (we never see anything but `kind`/`stream` in metadata)
 *        - ASSISTANCE upsert obeys connector-emitted axes
 *        - resolveByRequestId transitions matching row to resolved /
 *          expired / cancelled
 *        - resolveAllOpen drains the tracker
 *        - store outage on upsert does NOT throw (collection keeps going)
 *
 *   2. Integration test against the real sqlite-backed store:
 *        - spawn a tiny stub connector that emits INTERACTION, then DONE
 *          succeeded
 *        - assert a `connector_attention_records` row appears with
 *          `next_action.source === "structured"` in the connection-health
 *          projection while the prompt is open
 *        - after DONE, the row is in a terminal lifecycle and stops
 *          driving needs_attention; the projection falls back through
 *          to whatever evidence remains (schedule fallback path).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AttentionLifecycle, AttentionRecord } from "../runtime/attention.ts";
import { type AttentionWriterOptions, createAttentionWriter } from "../runtime/attention-writer.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { getConnectorAttentionProjection, projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";
import {
  getDefaultConnectorAttentionStore,
  resetDefaultConnectorAttentionStoreCache,
} from "../server/stores/connector-attention-store.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

// ─── Fake store for unit tests ───────────────────────────────────────────────

/** The `store` shape `createAttentionWriter` requires, pulled off its public options type. */
type FakeAttentionStore = AttentionWriterOptions["store"];

interface UpsertCall {
  connectorId: string;
  connectorInstanceId: string | null;
  record: AttentionRecord;
}

interface TransitionCall {
  attentionId: string;
  now: string;
  to: AttentionLifecycle;
}

interface FakeStoreRow {
  connectorId: string;
  connectorInstanceId: string | null;
  lifecycle: AttentionLifecycle;
  record: AttentionRecord;
}

interface FakeStoreOptions {
  failOnTransition?: boolean;
  failOnUpsert?: boolean;
}

interface FakeStore extends FakeAttentionStore {
  rows: Map<string, FakeStoreRow>;
  transitionCalls: TransitionCall[];
  upsertCalls: UpsertCall[];
}

function createFakeStore(opts: FakeStoreOptions = {}): FakeStore {
  const rows = new Map<string, FakeStoreRow>();
  const upsertCalls: UpsertCall[] = [];
  const transitionCalls: TransitionCall[] = [];
  const failOnUpsert = opts.failOnUpsert === true;
  const failOnTransition = opts.failOnTransition === true;
  return {
    rows,
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async transitionAttention({ attentionId, to, now }: TransitionCall) {
      transitionCalls.push({ attentionId, now, to });
      if (failOnTransition) {
        throw new Error("boom: transition failed");
      }
      const existing = rows.get(attentionId);
      if (!existing) {
        return null;
      }
      existing.lifecycle = to;
      existing.record = { ...existing.record, lifecycle: to, updated_at: now };
      return existing.record;
    },
    transitionCalls,
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async upsertAttention(args: UpsertCall) {
      upsertCalls.push(args);
      if (failOnUpsert) {
        throw new Error("boom: upsert failed");
      }
      rows.set(args.record.id, { ...args, lifecycle: args.record.lifecycle });
      return args.record;
    },
    upsertCalls,
  };
}

/**
 * The runtime protocol's real INTERACTION/ASSISTANCE messages carry
 * `message` (owner-facing copy) and, for INTERACTION, an optional `schema`
 * — fields `recordInteractionRequest`/`recordAssistanceRequest` deliberately
 * never read (see the "never leaks the submitted value" contract above).
 * These local types let the tests send the full wire shape so that
 * omission is actually exercised, without widening the writer's own
 * `InteractionMessage`/`AssistanceMessage` parameter types.
 */
type InteractionMessageInput = Parameters<ReturnType<typeof createAttentionWriter>["recordInteractionRequest"]>[0] & {
  message?: string;
  schema?: Record<string, unknown>;
};

type AssistanceMessageInput = Parameters<ReturnType<typeof createAttentionWriter>["recordAssistanceRequest"]>[0] & {
  message?: string;
};

function withTempDb(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-attwriter-"));
    resetDefaultConnectorAttentionStoreCache();
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      resetDefaultConnectorAttentionStoreCache();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

/**
 * Minimal admission fixture for `runConnector`'s required `admitRunConnection`
 * callback: echoes back whatever connectorId/connectorInstanceId/ownerSubjectId
 * it is asked to admit, satisfying the exact-match checks in
 * `admitRuntimeRunConnection` (runtime/index.ts) without asserting anything
 * about the admission decision itself.
 */
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    // Echo the explicit claim when the caller made one; otherwise fall back to
    // the same deterministic default-account binding the storage layer itself
    // derives (`getConnectorAttentionProjection` with no explicit instance id
    // resolves to this same id), so writer upserts and reader queries agree.
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

/**
 * Narrowing a `let` binding that is reassigned inside a nested closure (the
 * `onInteraction` callback below) confuses this toolchain's control-flow
 * analysis at the read site — reading the property directly off the
 * narrowed variable (or even a *generic* helper's inferred type parameter
 * for that argument) spuriously resolves to `never` instead of the
 * non-null arm. A concrete (non-generic) helper typed directly in terms of
 * the real return type sidesteps the bug.
 */
function requireProjection(
  value: Awaited<ReturnType<typeof getConnectorAttentionProjection>> | null,
  message: string
): Awaited<ReturnType<typeof getConnectorAttentionProjection>> {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

test("writer upserts a non-secret INTERACTION with action_target=remote_surface for manual_action", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    nowIso: () => "2026-05-19T12:00:00.000Z",
    runId: "run_1",
    store,
  });

  const interactionMsg: InteractionMessageInput = {
    kind: "manual_action",
    message: "Please complete the verification in the browser surface",
    request_id: "int_1",
    stream: "conversations",
    timeout_seconds: 60,
  };
  const attentionId = await writer.recordInteractionRequest(interactionMsg);

  assert.equal(attentionId, "att_run_1_int_1");
  assert.equal(store.upsertCalls.length, 1);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const upsert = store.upsertCalls[0];
  assert.ok(upsert);
  assert.equal(upsert.connectorId, "codex");
  assert.equal(upsert.connectorInstanceId, "cin_codex_a");
  assert.equal(upsert.record.action_target, "remote_surface");
  assert.equal(upsert.record.owner_action, "operate_attachment");
  assert.equal(upsert.record.response_contract, "response_required");
  assert.equal(upsert.record.sensitivity, "non_secret");
  assert.equal(upsert.record.reason_code, "manual_action_required");
  assert.equal(upsert.record.lifecycle, "open");
  // Expiry rolled forward by `timeout_seconds`.
  assert.equal(upsert.record.expires_at, "2026-05-19T12:01:00.000Z");
});

test("writer upserts a secret INTERACTION with sensitivity=secret for otp/credentials", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    runId: "run_2",
    store,
  });

  const otpMsg: InteractionMessageInput = {
    kind: "otp",
    message: "Enter OTP",
    request_id: "int_otp",
    // The runtime hands the schema to the spine event; the writer must
    // NEVER place secret-shaped values in the durable row. The only thing
    // it persists is the action_target enum and the non-secret reason
    // code/kind/stream. We confirm metadata is non-secret.
    schema: { properties: { otp: { type: "string" } }, type: "object" },
    stream: "conversations",
  };
  await writer.recordInteractionRequest(otpMsg);

  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const otpUpsert = store.upsertCalls[0];
  assert.ok(otpUpsert);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const record = otpUpsert.record;
  assert.equal(record.sensitivity, "secret");
  assert.equal(record.reason_code, "otp_required");
  assert.equal(record.owner_action, "provide_value");
  // Metadata contains only stream + kind — no schema, no submitted value.
  assert.deepEqual(Object.keys(record.metadata).sort(), ["kind", "stream"]);
  assert.equal(record.metadata.kind, "otp");
});

test("writer upserts ASSISTANCE honoring connector-supplied axes", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "chatgpt",
    connectorInstanceId: "cin_chatgpt_a",
    runId: "run_3",
    store,
  });

  const assistanceMsg: AssistanceMessageInput = {
    assistance_request_id: "asst_1",
    kind: "approve_in_app",
    message: "Approve in the ChatGPT iOS app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
    sensitivity: "non_secret",
    stream: "conversations",
  };
  await writer.recordAssistanceRequest(assistanceMsg);

  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const assistanceUpsert = store.upsertCalls[0];
  assert.ok(assistanceUpsert);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const record = assistanceUpsert.record;
  assert.equal(record.owner_action, "act_elsewhere");
  assert.equal(record.response_contract, "none");
  assert.equal(record.action_target, "external_app");
  assert.equal(record.sensitivity, "non_secret");
});

test("resolveByRequestId transitions matching row to resolved on success", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    runId: "run_4",
    store,
  });
  await writer.recordInteractionRequest({
    kind: "otp",
    request_id: "int_resolve",
  });
  const ok = await writer.resolveByRequestId("int_resolve", "success");
  assert.equal(ok, true);
  assert.equal(store.transitionCalls.length, 1);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const resolveTransition = store.transitionCalls[0];
  assert.ok(resolveTransition);
  assert.equal(resolveTransition.to, "resolved");
  assert.equal(resolveTransition.attentionId, "att_run_4_int_resolve");
  // No tracked rows remain.
  assert.equal(writer._trackedForTests().open.size, 0);
});

test("resolveByRequestId maps timeout -> expired and cancelled -> cancelled", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({ connectorId: "codex", runId: "run_5", store });
  await writer.recordInteractionRequest({ kind: "otp", request_id: "int_t" });
  await writer.resolveByRequestId("int_t", "timeout");
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const timeoutTransition = store.transitionCalls[0];
  assert.ok(timeoutTransition);
  assert.equal(timeoutTransition.to, "expired");

  await writer.recordInteractionRequest({ kind: "otp", request_id: "int_c" });
  await writer.resolveByRequestId("int_c", "cancelled");
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const cancelledTransition = store.transitionCalls[1];
  assert.ok(cancelledTransition);
  assert.equal(cancelledTransition.to, "cancelled");
});

test("resolveAllOpen drains every tracked row", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({ connectorId: "codex", runId: "run_6", store });
  await writer.recordInteractionRequest({ kind: "otp", request_id: "int_a" });
  await writer.recordAssistanceRequest({
    assistance_request_id: "asst_b",
    kind: "approve_in_app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
  });
  const drained = await writer.resolveAllOpen("cancelled");
  assert.equal(drained.length, 2);
  assert.equal(writer._trackedForTests().open.size, 0);
});

test("resolveAllOpen retains rows when a transient transition failure leaves them durable-open", async () => {
  const store = createFakeStore({ failOnTransition: true });
  const writer = createAttentionWriter({ connectorId: "codex", runId: "run_transition_retry", store });
  await writer.recordAssistanceRequest({
    assistance_request_id: "asst_retry",
    kind: "approve_in_app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
  });

  assert.deepEqual(await writer.resolveAllOpen("cancelled"), []);
  assert.equal(writer._trackedForTests().open.size, 1);
});

test("resolveByRequestId retains tracking when a transient transition failure leaves the row durable-open", async () => {
  const store = createFakeStore({ failOnTransition: true });
  const writer = createAttentionWriter({ connectorId: "codex", runId: "run_request_retry", store });
  await writer.recordAssistanceRequest({
    assistance_request_id: "asst_request_retry",
    kind: "approve_in_app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
  });

  assert.equal(await writer.resolveByRequestId("asst_request_retry", "resolved"), false);
  assert.equal(writer._trackedForTests().open.size, 1);
});

test("multiple open ASSISTANCE prompts sharing a dedupe key resolve independently", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({ connectorId: "chatgpt", runId: "run_shared", store });

  await writer.recordAssistanceRequest({
    assistance_request_id: "asst_first",
    kind: "approve_in_app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
    stream: "conversations",
  });
  await writer.recordAssistanceRequest({
    assistance_request_id: "asst_second",
    kind: "approve_in_app",
    owner_action: "act_elsewhere",
    progress_posture: "blocked",
    response_contract: "none",
    stream: "conversations",
  });

  assert.equal(writer._trackedForTests().open.size, 2);
  assert.equal(await writer.resolveByRequestId("asst_first", "resolved"), true);
  assert.equal(writer._trackedForTests().open.size, 1);
  assert.equal(await writer.resolveByRequestId("asst_second", "cancelled"), true);
  assert.equal(writer._trackedForTests().open.size, 0);
  assert.deepEqual(
    store.transitionCalls.map((call) => [call.attentionId, call.to]),
    [
      ["att_run_shared_asst_first", "resolved"],
      ["att_run_shared_asst_second", "cancelled"],
    ]
  );
});

test("store outage on upsert is non-fatal — writer returns null and resolveByRequestId reports no tracked row", async () => {
  const store = createFakeStore({ failOnUpsert: true });
  const warnings: string[] = [];
  const writer = createAttentionWriter({
    connectorId: "codex",
    log: { warn: (m: string) => warnings.push(m) },
    runId: "run_outage",
    store,
  });
  const attentionId = await writer.recordInteractionRequest({
    kind: "otp",
    request_id: "int_unhappy",
  });
  assert.equal(attentionId, null);
  assert.equal(warnings.length, 1);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const firstWarning = warnings[0];
  assert.ok(firstWarning);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(firstWarning, /upsert failed/);

  // No tracked row means resolveByRequestId returns false and does not
  // attempt a transition. Important: the run keeps going.
  const ok = await writer.resolveByRequestId("int_unhappy", "success");
  assert.equal(ok, false);
  assert.equal(store.transitionCalls.length, 0);
});

// ─── Integration: real store, real spawn ─────────────────────────────────────

test(
  "runConnector with INTERACTION writes a structured row that drives needs_attention",
  withTempDb(async (dir) => {
    const tmpStubDir = mkdtempSync(join(dir, "stub-"));
    const stubPath = join(tmpStubDir, "stub-interaction.js");
    // Tiny connector: read START, emit a single INTERACTION (otp),
    // wait for INTERACTION_RESPONSE, then emit DONE succeeded.
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        "let buffered = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  buffered += chunk;",
        "  let idx;",
        "  while ((idx = buffered.indexOf('\\n')) !== -1) {",
        "    const line = buffered.slice(0, idx);",
        "    buffered = buffered.slice(idx + 1);",
        "    if (!line.trim()) continue;",
        "    let msg;",
        "    try { msg = JSON.parse(line); } catch { continue; }",
        "    if (msg.type === 'START') {",
        "      process.stdout.write(JSON.stringify({",
        "        type: 'INTERACTION',",
        "        request_id: 'int_run',",
        "        kind: 'otp',",
        "        message: 'Enter OTP for codex',",
        "      }) + '\\n');",
        "    } else if (msg.type === 'INTERACTION_RESPONSE') {",
        "      process.stdout.write(JSON.stringify({",
        "        type: 'DONE',",
        "        status: 'succeeded',",
        "        records_emitted: 0,",
        "      }) + '\\n');",
        "      setImmediate(() => process.exit(0));",
        "    }",
        "  }",
        "});",
        "",
      ].join("\n"),
      "utf8"
    );
    chmodSync(stubPath, 0o755);

    const manifest = {
      connector_id: "codex",
      runtime_requirements: { bindings: { interactive: { required: false } } },
      streams: [
        {
          name: "conversations",
          primary_key: "id",
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        },
      ],
      version: "0.0.1",
    };

    // Observed projection while the prompt is still pending.
    let pendingProjection: Awaited<ReturnType<typeof getConnectorAttentionProjection>> | null = null;
    const onInteraction = async () => {
      // Read attention store at the moment the prompt is open. The
      // structured row should already be persisted because the writer
      // upserts before runConnector hands the interaction to onInteraction.
      pendingProjection = await getConnectorAttentionProjection("codex");
      return { request_id: "int_run", status: "success", type: "INTERACTION_RESPONSE" };
    };

    const outcome = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: "codex",
      connectorPath: stubPath,
      manifest,
      onInteraction,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
      onProgress: () => {},
      ownerToken: "test-owner",
      rsUrl: "http://127.0.0.1:1",
      state: null,
    });

    assert.equal(outcome.status, "succeeded");

    // While interaction was open, projection saw structured next_action.
    assert.ok(pendingProjection, "pendingProjection captured");
    const capturedProjection = requireProjection(pendingProjection, "pendingProjection captured");
    assert.equal(capturedProjection.unreliable, false);
    assert.equal(capturedProjection.records.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const pendingRow = capturedProjection.records[0];
    assert.ok(pendingRow);
    assert.equal(pendingRow.reason_code, "otp_required");
    assert.equal(pendingRow.sensitivity, "secret");

    const pendingHealth = projectConnectorSummaryConnectionHealth({
      attentionRecords: capturedProjection.records,
      freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
      // The projection's "never run" guard short-circuits to `idle` when
      // there's no terminal run evidence. A real run that produces an
      // INTERACTION has terminal evidence; use a failed-run shape so the
      // projection reaches the attention precedence rung.
      lastRun: {
        collection_facts: null,
        event_count: 1,
        failure_reason: "manual_verification_required",
        finished_at: "2026-05-19T12:00:00.000Z",
        first_at: "2026-05-19T11:59:00.000Z",
        known_gaps: [],
        last_at: "2026-05-19T12:00:00.000Z",
        recovery_only: false,
        run_id: "run_pending",
        started_at: "2026-05-19T11:59:00.000Z",
        status: "failed",
        terminal_reason: null,
      },
      lastSuccessfulRun: null,
      nowIso: "2026-05-19T12:00:00.000Z",
      schedule: null,
    });
    assert.equal(pendingHealth.state, "needs_attention");
    assert.equal(pendingHealth.next_action?.source, "structured");
    // Secret-sensitive rows suppress action_target.
    assert.equal(pendingHealth.next_action?.action_target, null);

    // After DONE success, no open rows remain — the writer transitioned
    // the attention to resolved as part of INTERACTION_RESPONSE handling.
    const postProjection = await getConnectorAttentionProjection("codex");
    assert.equal(postProjection.unreliable, false);
    assert.equal(postProjection.records.length, 0);
  })
);

test(
  "runConnector without structured rows still lets schedule fallback drive needs_attention",
  withTempDb(async () => {
    // No attention writes happen because the connector emits no
    // INTERACTION/ASSISTANCE. The schedule fallback (caller-provided
    // `human_attention_needed`) must still be honored — guards against
    // a regression where the structured pathway accidentally suppresses
    // the existing schedule fallback.
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const records = (await getConnectorAttentionProjection("codex_idle")).records;
    assert.equal(records.length, 0);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: records,
      freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
      lastRun: {
        collection_facts: null,
        event_count: 1,
        failure_reason: "browser_runtime_not_configured",
        finished_at: "2026-05-19T12:00:00.000Z",
        first_at: "2026-05-19T11:59:00.000Z",
        known_gaps: [],
        last_at: "2026-05-19T12:00:00.000Z",
        recovery_only: false,
        run_id: "run_failed",
        started_at: "2026-05-19T11:59:00.000Z",
        status: "failed",
        terminal_reason: null,
      },
      lastSuccessfulRun: null,
      nowIso: "2026-05-19T12:00:00.000Z",
      schedule: {
        enabled: true,
        human_attention_needed: true,
        last_error_code: "browser_runtime_not_configured",
      },
    });
    assert.equal(snapshot.state, "needs_attention");
    assert.equal(snapshot.next_action?.source, "schedule_fallback");
  })
);

test(
  "real store path: default store returns null when neither writer nor record present",
  withTempDb(async () => {
    // Sanity check: the default store path is reachable from the writer
    // (so runtime/index.ts doesn't have to inject one in production)
    // and an empty connector yields an empty open list rather than a
    // false-healthy state.
    const store = getDefaultConnectorAttentionStore();
    const rows = await store.listOpenAttentionForConnection({
      connectorId: "codex_empty",
      connectorInstanceId: "cin_codex_empty",
    });
    assert.deepEqual(rows, []);
  })
);

// ─── Notification-state writer tests ───────────────────────────────────────

test("writer.recordNotificationOutcome updates the tracked row without touching lifecycle", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    runId: "run_notify_1",
    store,
  });
  const attentionId = await writer.recordInteractionRequest({
    kind: "manual_action",
    request_id: "int_1",
    stream: "conversations",
  });
  assert.ok(attentionId);

  const next = await writer.recordNotificationOutcome(attentionId, "sent", null);
  assert.ok(next, "recordNotificationOutcome should return the updated record");
  assert.equal(next.notification_state, "sent");
  assert.equal(next.lifecycle, "open", "notification outcome must NOT close the prompt");

  // Confirm the writer re-upserted the same row id (no fan-out).
  assert.equal(store.upsertCalls.length, 2);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const secondUpsert = store.upsertCalls[1];
  assert.ok(secondUpsert);
  assert.equal(secondUpsert.record.id, attentionId);
  assert.equal(secondUpsert.record.notification_state, "sent");
});

test("writer.recordNotificationOutcome records failed delivery and keeps prompt open", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    runId: "run_notify_2",
    store,
  });
  const attentionId = await writer.recordInteractionRequest({
    kind: "manual_action",
    request_id: "int_a",
    stream: "conversations",
  });
  assert.ok(attentionId);

  const next = await writer.recordNotificationOutcome(attentionId, "failed", "transport: 410 gone");
  assert.ok(next);
  assert.equal(next.notification_state, "failed");
  assert.equal(next.notification_reason, "transport: 410 gone");
  assert.equal(next.lifecycle, "open", "failed delivery does NOT terminate the attention");
});

test("writer.recordNotificationOutcome returns null when attentionId is not tracked", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    runId: "run_notify_3",
    store,
  });
  const next = await writer.recordNotificationOutcome("att_nonexistent", "sent", null);
  assert.equal(next, null);
});

test("writer.attentionIdForRequest exposes the deterministic id for the push seam", async () => {
  const store = createFakeStore();
  const writer = createAttentionWriter({
    connectorId: "codex",
    connectorInstanceId: "cin_codex_a",
    runId: "run_lookup_1",
    store,
  });
  const attentionId = await writer.recordInteractionRequest({
    kind: "manual_action",
    request_id: "int_lookup",
    stream: "conversations",
  });
  assert.equal(writer.attentionIdForRequest("int_lookup"), attentionId);
  assert.equal(writer.attentionIdForRequest("missing"), null);
});
