// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { hasResponseSchema, validateResponse } from "../src/index.ts";

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
  connection_id: "cin_amazon_personal",
  connector_id: "amazon",
  connector_instance_id: "cin_amazon_personal",
  connector_key: "amazon",
  created_at: "2026-05-31T00:00:00.000Z",
  display_name: "the owner personal",
  label_status: "owner_set",
  object: "owner_connection",
  revoked_at: null,
  schedule: null,
  source_binding: { account_hint: "the owner@example.com" },
  source_kind: "account",
  status: "active",
  supported_actions: [
    {
      family: "rename_connection",
      method: "PATCH",
      reason: "Set a connection display_name.",
      status: "supported",
      url: "https://rs.example/v1/owner/connections/cin_amazon_personal",
    },
    {
      family: "run_connection",
      method: "POST",
      reason: "Start a run-now for a connection by connection_id.",
      status: "supported",
      url: "https://rs.example/v1/owner/connections/cin_amazon_personal/run",
    },
    {
      family: "delete_connection",
      method: "DELETE",
      reason: "Delete a connection by connection_id to erase its data and remove its configuration.",
      status: "supported",
      url: "https://rs.example/v1/owner/connections/cin_amazon_personal",
    },
  ],
  updated_at: "2026-05-31T00:00:00.000Z",
};

const OWNER_CONNECTOR_TEMPLATE_ROW = {
  connection_count: 1,
  connections: [
    {
      connection_id: "cin_amazon_personal",
      connector_id: "amazon",
      connector_instance_id: "cin_amazon_personal",
      connector_key: "amazon",
      created_at: "2026-05-31T00:00:00.000Z",
      display_name: "the owner personal",
      label_status: "owner_set",
      object: "owner_connection_summary",
      revoked_at: null,
      source_kind: "account",
      status: "active",
      updated_at: "2026-05-31T00:00:00.000Z",
    },
  ],
  connector_id: "amazon",
  connector_key: "amazon",
  connector_modality: "browser_bound",
  display_name: "Amazon",
  object: "owner_connector_template",
  setup_plan: {
    deployment_readiness: {},
    next_step_kind: "enroll_browser_collector",
    proof_gate: "browser_collector_live_proof_missing",
    runbook_path: null,
    setup_modality: "browser_bound",
    support_state: "proof_gated",
  },
  stream_count: 2,
  supported_actions: [
    {
      family: "initiate_connection",
      method: null,
      reason: "Browser-bound connectors require a browser-collector primitive.",
      status: "unsupported",
      url: null,
    },
  ],
  version: "0.1.0",
};

test("ownerListConnections declares a 200 and the shared error statuses", () => {
  assert.equal(hasResponseSchema("ownerListConnections", 200), true);
  assert.equal(hasResponseSchema("ownerListConnections", 409), true);
});

test("ownerListConnectorTemplates declares a 200 and the shared error statuses", () => {
  assert.equal(hasResponseSchema("ownerListConnectorTemplates", 200), true);
  assert.equal(hasResponseSchema("ownerListConnectorTemplates", 409), true);
});

test("a connection row with supported_actions validates against the contract", () => {
  const result = validateResponse("ownerListConnections", {
    body: { data: [OWNER_CONNECTION_ROW], object: "list" },
    status: 200,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test("a connector template row with connection summaries validates against the contract", () => {
  const result = validateResponse("ownerListConnectorTemplates", {
    body: { data: [OWNER_CONNECTOR_TEMPLATE_ROW], object: "list" },
    status: 200,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test("supported_actions items must match the control-action shape", () => {
  const badRow = {
    ...OWNER_CONNECTION_ROW,
    supported_actions: [{ family: "rename_connection" }], // missing required status/method/url/reason
  };
  const result = validateResponse("ownerListConnections", {
    body: { data: [badRow], object: "list" },
    status: 200,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test("an ambiguity error envelope with available_connections + retry_with validates", () => {
  // This is the exact shape `pdppError(res, 409, "ambiguous_connection", ...,
  // { available_connections, retry_with })` emits for a connector-only target
  // that matches more than one configured connection.
  const result = validateResponse("ownerListConnections", {
    body: {
      error: {
        available_connections: [
          {
            connection_id: "cin_amazon_personal",
            connector_id: "amazon",
            connector_key: "amazon",
            display_name: "the owner personal",
            label_status: "owner_set",
          },
          {
            connection_id: "cin_amazon_shared",
            connector_id: "amazon",
            connector_key: "amazon",
            display_name: null,
            label_status: "fallback",
          },
        ],
        code: "ambiguous_connection",
        message: "connector 'amazon' has more than one configured connection; retry with a connection_id.",
        param: "connector_id",
        request_id: "req_deadbeef",
        retry_with: "connection_id",
        type: "conflict_error",
      },
    },
    status: 409,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test("a plain typed error envelope (no ambiguity hints) still validates", () => {
  const result = validateResponse("ownerListConnections", {
    body: {
      error: {
        code: "connector_instance_not_found",
        message: "connection_id not found",
        request_id: "req_cafef00d",
        type: "not_found_error",
      },
    },
    status: 404,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test("an error envelope with an undeclared field still fails closed", () => {
  const result = validateResponse("ownerListConnections", {
    body: {
      error: {
        code: "invalid_request",
        message: "bad",
        not_a_declared_field: true,
        request_id: "req_1",
        type: "invalid_request_error",
      },
    },
    status: 400,
  });
  assert.equal(result.ok, false);
});
