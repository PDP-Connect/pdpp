import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  SourceWebhookError,
  executeSourceWebhook,
} from '../operations/ref-source-webhook-ingest/index.ts';

const NOW_MS = Date.parse('2026-05-15T12:00:00.000Z');
const SECRET = 'source_secret';

function sign(body, timestamp = String(Math.floor(NOW_MS / 1000))) {
  return `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
}

function deps(overrides = {}) {
  return {
    nowMs: () => NOW_MS,
    resolveSecret: () => SECRET,
    claimEvent: () => true,
    ingestRecords: async () => ({
      stream: 'messages',
      records_accepted: 1,
      records_rejected: 0,
      errors: [],
    }),
    signalScheduler: () => undefined,
    ...overrides,
  };
}

function input(body, overrides = {}) {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  return {
    sourceId: 'gmail',
    body,
    timestamp,
    eventId: 'evt_1',
    signature: sign(body, timestamp),
    ...overrides,
  };
}

test('ref.source-webhook verifies HMAC before processing', async () => {
  await assert.rejects(
    () => executeSourceWebhook(input('{"action":"schedule_run"}', { signature: 'sha256=bad' }), deps()),
    (err) => {
      assert.ok(err instanceof SourceWebhookError);
      assert.equal(err.code, 'invalid_signature');
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test('ref.source-webhook rejects stale timestamps', async () => {
  const body = '{"action":"schedule_run"}';
  await assert.rejects(
    () => executeSourceWebhook(input(body, { timestamp: '1', signature: sign(body, '1') }), deps()),
    (err) => {
      assert.equal(err.code, 'stale_timestamp');
      return true;
    },
  );
});

test('ref.source-webhook returns duplicate without applying action', async () => {
  let signaled = false;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      claimEvent: () => false,
      signalScheduler: () => {
        signaled = true;
      },
    }),
  );
  assert.equal(result.duplicate, true);
  assert.equal(signaled, false);
});

test('ref.source-webhook maps records into ingest operation shape', async () => {
  let captured;
  const body = JSON.stringify({
    action: 'ingest_records',
    stream: 'messages',
    records: [{ id: 'm1' }, { id: 'm2' }],
  });
  const result = await executeSourceWebhook(
    input(body),
    deps({
      ingestRecords: async (payload) => {
        captured = payload;
        return { stream: payload.streamName, records_accepted: 2, records_rejected: 0, errors: [] };
      },
    }),
  );
  assert.equal(result.action, 'ingest_records');
  assert.deepEqual(captured, {
    connectorId: 'gmail',
    streamName: 'messages',
    body: '{"id":"m1"}\n{"id":"m2"}',
  });
  assert.equal(result.ingest.records_accepted, 2);
});

test('ref.source-webhook maps run trigger to scheduler signal only', async () => {
  let captured;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: ({ connectorId, triggerKind }) => ({
        trigger_kind: triggerKind,
        automation_mode: connectorId === 'gmail' ? 'assisted' : 'unattended',
        allowed_to_start: true,
      }),
      signalScheduler: (payload) => {
        captured = payload;
      },
    }),
  );
  assert.equal(result.action, 'schedule_run');
  assert.equal(result.trigger_kind, 'webhook');
  assert.equal(result.automation_policy.trigger_kind, 'webhook');
  assert.equal(result.automation_policy.automation_mode, 'assisted');
  assert.equal(captured.connectorId, 'gmail');
  assert.equal(captured.eventId, 'evt_1');
});

test('ref.source-webhook starts webhook-classified run when run dependency is available', async () => {
  let signaled = false;
  let capturedRunRequest;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: () => ({
        trigger_kind: 'webhook',
        automation_mode: 'unattended',
        allowed_to_start: true,
      }),
      signalScheduler: () => {
        signaled = true;
      },
      requestRun: (payload) => {
        capturedRunRequest = payload;
        return {
          run_id: 'run_webhook',
          trace_id: 'trc_webhook',
          status: 'started',
          trigger_kind: 'webhook',
          automation_mode: 'unattended',
        };
      },
    }),
  );

  assert.equal(signaled, false);
  assert.equal(capturedRunRequest.triggerKind, 'webhook');
  assert.equal(capturedRunRequest.automationPolicy.trigger_kind, 'webhook');
  assert.equal(result.run.run_id, 'run_webhook');
  assert.equal(result.run.trigger_kind, 'webhook');
});

test('ref.source-webhook does not start webhook run when automation policy blocks it', async () => {
  let requested = false;
  const result = await executeSourceWebhook(
    input('{"action":"schedule_run"}'),
    deps({
      projectAutomationPolicy: () => ({
        trigger_kind: 'webhook',
        automation_mode: 'manual_only',
        allowed_to_start: false,
        reason: 'manual-only',
      }),
      requestRun: () => {
        requested = true;
        return null;
      },
    }),
  );

  assert.equal(requested, false);
  assert.equal(result.automation_policy.automation_mode, 'manual_only');
  assert.equal(result.run, null);
});
