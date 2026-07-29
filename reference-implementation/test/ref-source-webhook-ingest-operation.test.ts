// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  executeSourceWebhook,
  type SourceWebhookDependencies,
  SourceWebhookError,
  type SourceWebhookInput,
} from "../operations/ref-source-webhook-ingest/index.ts";

const NOW_MS = Date.parse("2026-05-15T12:00:00.000Z");
const SECRET = "source_secret";

function sign(body: string, timestamp = String(Math.floor(NOW_MS / 1000))): string {
  return `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
}

function deps(overrides: Partial<SourceWebhookDependencies> = {}): SourceWebhookDependencies {
  return {
    claimEvent: () => true,
    ingestRecords: async () => ({
      errors: [],
      records_accepted: 1,
      records_rejected: 0,
      stream: "messages",
    }),
    nowMs: () => NOW_MS,
    resolveSecret: () => SECRET,
    signalScheduler: () => undefined,
    ...overrides,
  };
}

function input(body: string, overrides: Partial<SourceWebhookInput> = {}): SourceWebhookInput {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  return {
    body,
    eventId: "evt_1",
    signature: sign(body, timestamp),
    sourceId: "gmail",
    timestamp,
    ...overrides,
  };
}

test("ref.source-webhook verifies HMAC before processing", async () => {
  await assert.rejects(
    () => executeSourceWebhook(input('{"action":"schedule_run"}', { signature: "sha256=bad" }), deps()),
    (err: unknown) => {
      assert.ok(err instanceof SourceWebhookError);
      assert.equal(err.code, "invalid_signature");
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test("ref.source-webhook rejects stale timestamps", async () => {
  const body = '{"action":"schedule_run"}';
  await assert.rejects(
    () => executeSourceWebhook(input(body, { signature: sign(body, "1"), timestamp: "1" }), deps()),
    (err: unknown) => {
      assert.ok(err instanceof SourceWebhookError);
      assert.equal(err.code, "stale_timestamp");
      return true;
    }
  );
});

test("ref.source-webhook returns duplicate without applying action", async () => {
  let signaled = false;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      claimEvent: () => false,
      signalScheduler: () => {
        signaled = true;
      },
    })
  );
  assert.equal(result.duplicate, true);
  assert.equal(signaled, false);
});

test("ref.source-webhook maps records into ingest operation shape", async () => {
  let captured: Parameters<SourceWebhookDependencies["ingestRecords"]>[0] | undefined;
  const body = JSON.stringify({
    action: "ingest_records",
    records: [{ id: "m1" }, { id: "m2" }],
    stream: "messages",
  });
  const result = await executeSourceWebhook(
    input(body),
    deps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecords: async (payload) => {
        captured = payload;
        return { errors: [], records_accepted: 2, records_rejected: 0, stream: payload.streamName };
      },
    })
  );
  assert.equal(result.action, "ingest_records");
  assert.deepEqual(captured, {
    body: '{"id":"m1"}\n{"id":"m2"}',
    connectorId: "gmail",
    streamName: "messages",
  });
  assert.ok(result.ingest);
  assert.equal(result.ingest.records_accepted, 2);
});

test("ref.source-webhook maps run trigger to scheduler signal only", async () => {
  let captured: Parameters<SourceWebhookDependencies["signalScheduler"]>[0] | undefined;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: ({ connectorId, triggerKind }) => ({
        allowed_to_start: true,
        automation_mode: connectorId === "gmail" ? "assisted" : "unattended",
        trigger_kind: triggerKind,
      }),
      signalScheduler: (payload) => {
        captured = payload;
      },
    })
  );
  assert.equal(result.action, "schedule_run");
  assert.equal(result.trigger_kind, "webhook");
  assert.ok(result.automation_policy && captured);
  assert.equal(result.automation_policy.trigger_kind, "webhook");
  assert.equal(result.automation_policy.automation_mode, "assisted");
  assert.equal(captured.connectorId, "gmail");
  assert.equal(captured.eventId, "evt_1");
});

test("ref.source-webhook starts webhook-classified run when run dependency is available", async () => {
  let signaled = false;
  let capturedRunRequest: Parameters<NonNullable<SourceWebhookDependencies["requestRun"]>>[0] | undefined;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: () => ({
        allowed_to_start: true,
        automation_mode: "unattended",
        trigger_kind: "webhook",
      }),
      requestRun: (payload) => {
        capturedRunRequest = payload;
        return {
          automation_mode: "unattended",
          run_id: "run_webhook",
          status: "started",
          trace_id: "trc_webhook",
          trigger_kind: "webhook",
        };
      },
      signalScheduler: () => {
        signaled = true;
      },
    })
  );

  assert.equal(signaled, false);
  assert.ok(capturedRunRequest && result.run);
  assert.equal(capturedRunRequest.triggerKind, "webhook");
  assert.equal(capturedRunRequest.automationPolicy.trigger_kind, "webhook");
  assert.equal(result.run.run_id, "run_webhook");
  assert.equal(result.run.trigger_kind, "webhook");
});

test("ref.source-webhook canonicalizes a URL-shaped configured connector id for ingest", async () => {
  let captured: Parameters<SourceWebhookDependencies["ingestRecords"]>[0] | undefined;
  const body = JSON.stringify({
    action: "ingest_records",
    records: [{ id: "m1" }],
    stream: "messages",
  });
  const result = await executeSourceWebhook(
    input(body),
    deps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecords: async (payload) => {
        captured = payload;
        return { errors: [], records_accepted: 1, records_rejected: 0, stream: payload.streamName };
      },
      resolveConnectorId: () => "https://registry.pdpp.org/connectors/gmail",
    })
  );
  assert.equal(result.action, "ingest_records");
  assert.ok(captured);
  assert.equal(captured.connectorId, "gmail");
});

test("ref.source-webhook canonicalizes a legacy-alias configured connector id for scheduler signal", async () => {
  let captured: Parameters<SourceWebhookDependencies["signalScheduler"]>[0] | undefined;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      resolveConnectorId: () => "claude_code",
      signalScheduler: (payload) => {
        captured = payload;
      },
    })
  );
  assert.equal(result.action, "schedule_run");
  assert.ok(captured);
  assert.equal(captured.connectorId, "claude-code");
});

test("ref.source-webhook canonicalizes a URL-shaped configured connector id for run request", async () => {
  let capturedPolicy: Parameters<NonNullable<SourceWebhookDependencies["projectAutomationPolicy"]>>[0] | undefined;
  let capturedRunRequest: Parameters<NonNullable<SourceWebhookDependencies["requestRun"]>>[0] | undefined;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: (payload) => {
        capturedPolicy = payload;
        return { allowed_to_start: true, automation_mode: "unattended", trigger_kind: "webhook" };
      },
      requestRun: (payload) => {
        capturedRunRequest = payload;
        return { run_id: "run_1", status: "started", trace_id: "trc_1", trigger_kind: "webhook" };
      },
      resolveConnectorId: () => "https://registry.pdpp.org/connectors/slack",
    })
  );
  assert.equal(result.action, "schedule_run");
  assert.ok(capturedPolicy && capturedRunRequest);
  assert.equal(capturedPolicy.connectorId, "slack");
  assert.equal(capturedRunRequest.connectorId, "slack");
});

test("ref.source-webhook does not start webhook run when automation policy blocks it", async () => {
  let requested = false;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: () => ({
        allowed_to_start: false,
        automation_mode: "manual_only",
        reason: "manual-only",
        trigger_kind: "webhook",
      }),
      requestRun: () => {
        requested = true;
        return null;
      },
    })
  );

  assert.equal(requested, false);
  assert.ok(result.automation_policy);
  assert.equal(result.automation_policy.automation_mode, "manual_only");
  assert.equal(result.run, null);
});
