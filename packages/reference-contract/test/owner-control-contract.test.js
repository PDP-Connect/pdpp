import assert from 'node:assert/strict';
import test from 'node:test';

import { hasResponseSchema, validateResponse } from '../src/index.ts';

// Contract coverage for the owner-agent control surface schema additions made
// in openspec/changes/add-owner-agent-control-surface:
//
//   - every `owner_connection` row carries a `supported_actions` array of typed
//     control actions (task 2.2 / design.md #5);
//   - the shared PDPP error envelope can carry the ambiguity-resolution hints
//     `available_connections` + `retry_with` that `pdppError` already emits, so
//     a typed `ambiguous_connection` error validates against the contract
//     instead of being silently illegal under `additionalProperties: false`
//     (task 2.4).
//
// These exercise `validateResponse` against the published `ownerListConnections`
// manifest (200 success schema and the shared CommonErrors envelopes), so the
// test fails closed if the schema regresses.

const OWNER_CONNECTION_ROW = {
  object: 'owner_connection',
  connection_id: 'cin_amazon_personal',
  connector_instance_id: 'cin_amazon_personal',
  connector_id: 'amazon',
  connector_key: 'amazon',
  display_name: 'the owner personal',
  label_status: 'owner_set',
  status: 'active',
  source_kind: 'account',
  source_binding: { account_hint: 'the owner@example.com' },
  created_at: '2026-05-31T00:00:00.000Z',
  updated_at: '2026-05-31T00:00:00.000Z',
  revoked_at: null,
  schedule: null,
  supported_actions: [
    {
      family: 'rename_connection',
      status: 'supported',
      method: 'PATCH',
      url: 'https://rs.example/v1/owner/connections/cin_amazon_personal',
      reason: 'Set a connection display_name.',
    },
    {
      family: 'run_connection',
      status: 'supported',
      method: 'POST',
      url: 'https://rs.example/v1/owner/connections/cin_amazon_personal/run',
      reason: 'Start a run-now for a connection by connection_id.',
    },
    {
      family: 'delete_connection',
      status: 'supported',
      method: 'DELETE',
      url: 'https://rs.example/v1/owner/connections/cin_amazon_personal',
      reason: 'Delete a connection by connection_id to erase its data and remove its configuration.',
    },
  ],
};

const OWNER_CONNECTOR_TEMPLATE_ROW = {
  object: 'owner_connector_template',
  connector_id: 'amazon',
  connector_key: 'amazon',
  display_name: 'Amazon',
  version: '0.1.0',
  connector_modality: 'browser_bound',
  setup_plan: {
    setup_modality: 'browser_bound',
    support_state: 'proof_gated',
    next_step_kind: 'enroll_browser_collector',
    proof_gate: 'browser_collector_live_proof_missing',
    runbook_path: null,
    deployment_readiness: {},
  },
  stream_count: 2,
  connection_count: 1,
  connections: [
    {
      object: 'owner_connection_summary',
      connection_id: 'cin_amazon_personal',
      connector_instance_id: 'cin_amazon_personal',
      connector_id: 'amazon',
      connector_key: 'amazon',
      display_name: 'the owner personal',
      label_status: 'owner_set',
      status: 'active',
      source_kind: 'account',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
      revoked_at: null,
    },
  ],
  supported_actions: [
    {
      family: 'initiate_connection',
      status: 'unsupported',
      method: null,
      url: null,
      reason: 'Browser-bound connectors require a browser-collector primitive.',
    },
  ],
};

test('ownerListConnections declares a 200 and the shared error statuses', () => {
  assert.equal(hasResponseSchema('ownerListConnections', 200), true);
  assert.equal(hasResponseSchema('ownerListConnections', 409), true);
});

test('ownerListConnectorTemplates declares a 200 and the shared error statuses', () => {
  assert.equal(hasResponseSchema('ownerListConnectorTemplates', 200), true);
  assert.equal(hasResponseSchema('ownerListConnectorTemplates', 409), true);
});

test('a connection row with supported_actions validates against the contract', () => {
  const result = validateResponse('ownerListConnections', {
    status: 200,
    body: { object: 'list', data: [OWNER_CONNECTION_ROW] },
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test('a connector template row with connection summaries validates against the contract', () => {
  const result = validateResponse('ownerListConnectorTemplates', {
    status: 200,
    body: { object: 'list', data: [OWNER_CONNECTOR_TEMPLATE_ROW] },
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test('supported_actions items must match the control-action shape', () => {
  const badRow = {
    ...OWNER_CONNECTION_ROW,
    supported_actions: [{ family: 'rename_connection' }], // missing required status/method/url/reason
  };
  const result = validateResponse('ownerListConnections', {
    status: 200,
    body: { object: 'list', data: [badRow] },
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test('an ambiguity error envelope with available_connections + retry_with validates', () => {
  // This is the exact shape `pdppError(res, 409, "ambiguous_connection", ...,
  // { available_connections, retry_with })` emits for a connector-only target
  // that matches more than one configured connection.
  const result = validateResponse('ownerListConnections', {
    status: 409,
    body: {
      error: {
        type: 'conflict_error',
        code: 'ambiguous_connection',
        message: "connector 'amazon' has more than one configured connection; retry with a connection_id.",
        param: 'connector_id',
        request_id: 'req_deadbeef',
        retry_with: 'connection_id',
        available_connections: [
          {
            connection_id: 'cin_amazon_personal',
            connector_id: 'amazon',
            connector_key: 'amazon',
            display_name: 'the owner personal',
            label_status: 'owner_set',
          },
          {
            connection_id: 'cin_amazon_shared',
            connector_id: 'amazon',
            connector_key: 'amazon',
            display_name: null,
            label_status: 'fallback',
          },
        ],
      },
    },
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test('a plain typed error envelope (no ambiguity hints) still validates', () => {
  const result = validateResponse('ownerListConnections', {
    status: 404,
    body: {
      error: {
        type: 'not_found_error',
        code: 'connector_instance_not_found',
        message: 'connection_id not found',
        request_id: 'req_cafef00d',
      },
    },
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test('an error envelope with an undeclared field still fails closed', () => {
  const result = validateResponse('ownerListConnections', {
    status: 400,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'bad',
        request_id: 'req_1',
        not_a_declared_field: true,
      },
    },
  });
  assert.equal(result.ok, false);
});
