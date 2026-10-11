// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { getManifest, hasResponseSchema, listOperations, validateRequest, validateResponse } from "../src/index.ts";
import { generateOpenApi } from "../src/openapi/index.ts";

// Contract coverage for the owner-agent control surface schema additions made
// in openspec/changes/add-owner-agent-control-surface:
//
//   - every bearer `owner_connection` row carries a `supported_actions` array of typed
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

// Runtime authority: data-connect #347 owner-runs.ts and shared run handlers.
// Exact method/path inventory catches routes missing from manifest-led checks.
const RUN_ROUTES = [
  ["ListRuns", "GET", ""],
  ["GetRunStatus", "GET", "/{runId}"],
  ["GetRunTimeline", "GET", "/{runId}/timeline"],
  ["CancelRun", "POST", "/{runId}/cancel"],
  ["RunInteraction", "POST", "/{runId}/interaction"],
] as const;

test("both owner run families declare all ten exact method/path bindings", () => {
  for (const [prefix, base] of [
    ["ref", "/_ref/runs"],
    ["owner", "/v1/owner/runs"],
  ]) {
    for (const [suffix, method, path] of RUN_ROUTES) {
      const manifest = getManifest(`${prefix}${suffix}`);
      assert.ok(manifest, `${prefix}${suffix} is missing`);
      assert.equal(
        listOperations().filter((operation) => operation.method === method && operation.path === `${base}${path}`)
          .length,
        1
      );
      assert.equal(manifest.method, method);
      assert.equal(manifest.path, `${base}${path}`);
      assert.equal(manifest.surface, "reference");
    }
  }
});

test("interaction requests accept null data and extra fields but reject blank IDs", () => {
  for (const id of ["refRunInteraction", "ownerRunInteraction"]) {
    assert.deepEqual(
      validateRequest(id, { body: { interaction_id: "int_1", status: "success", data: null, extra: true } }),
      { ok: true }
    );
    assert.equal(validateRequest(id, { body: { interaction_id: " \t\n", status: "success" } }).ok, false);
    assert.equal(validateRequest(id, { body: { interaction_id: "int_1", status: "success", data: [] } }).ok, false);
  }
});

test("owner run routes appear only in the full OpenAPI document", () => {
  const full = generateOpenApi({ includeReference: true });
  const publicDocument = generateOpenApi({ includeReference: false });
  for (const [prefix, base] of [
    ["ref", "/_ref/runs"],
    ["owner", "/v1/owner/runs"],
  ]) {
    for (const [suffix, method, path] of RUN_ROUTES) {
      assert.equal(full.paths[`${base}${path}`]?.[method.toLowerCase()]?.operationId, `${prefix}${suffix}`);
      assert.equal(publicDocument.paths[`${base}${path}`], undefined);
    }
  }
});

// Serialized field fixtures follow #347 run-status-read-model.ts,
// lib/spine.ts hydrateRows, and the two canonical spine operations.
const RUN_STATUS = {
  object: "run_status",
  run_id: "run_1",
  status: "waiting_for_browser_surface",
  completed_at: null,
  connector_id: null,
  connector_instance_id: null,
  failure: null,
  started_at: null,
  terminal_reason: null,
  trace_id: null,
  links: { timeline: "/_ref/runs/run_1/timeline" },
};
const RUN_SUMMARY = {
  object: "run_summary",
  run_id: "run_1",
  connector_id: null,
  failure_reason: null,
  grant_id: null,
  event_count: 1,
  first_at: "2026-10-10",
  last_at: "2026-10-10",
  status: "leased",
  kinds: ["run"],
  needs_input: false,
  source: null,
};
const RUN_EVENT = {
  actor_id: "owner",
  actor_type: "subject",
  event_id: "ev_1",
  event_type: "run.started",
  object_id: "run_1",
  object_type: "run",
  occurred_at: "2026-10-10",
  recorded_at: "2026-10-10",
  scenario_id: "scenario_1",
  status: "active",
  trace_id: "trace_1",
  version: "1",
  client_id: null,
  grant_id: null,
  interaction_id: null,
  request_id: null,
  run_id: "run_1",
  source_id: null,
  stream_id: null,
  subject_id: null,
  subject_type: null,
  source_kind: null,
  data: { unknown_payload: [1, null] },
};
const RUN_TIMELINE = {
  object: "run_timeline",
  run_id: "run_1",
  trace_id: null,
  data: [],
  event_count: 0,
  truncated: false,
  next_cursor: null,
  limit: 2000,
  terminal_status: "completed",
};

function expectResponse(id: string, status: number, body: unknown) {
  assert.deepEqual(validateResponse(id, { status, body }), { ok: true, skipped: false }, id);
}

test("both run families validate nullable status and raw known gaps", () => {
  for (const prefix of ["ref", "owner"]) {
    const id = `${prefix}GetRunStatus`;
    expectResponse(id, 200, RUN_STATUS);
    expectResponse(id, 200, {
      ...RUN_STATUS,
      status: "stored_future_status",
      known_gaps: [null, 3],
      known_gaps_summary: "raw",
      failure: {
        connector_error_message: null,
        message: null,
        origin: null,
        reason: null,
        recovery_hint: { action: "refresh_credentials", retryable: false },
      },
    });
    const { failure: _failure, ...missingFailure } = RUN_STATUS;
    assert.equal(validateResponse(id, { status: 200, body: missingFailure }).ok, false);
    assert.equal(validateResponse(id, { status: 200, body: { ...RUN_STATUS, failure: { reason: null } } }).ok, false);
  }
});

test("run lists omit absent cursors and accept browser-surface identity fields", () => {
  for (const prefix of ["ref", "owner"]) {
    const id = `${prefix}ListRuns`;
    expectResponse(id, 200, { object: "list", data: [RUN_SUMMARY], has_more: false });
    expectResponse(id, 200, {
      object: "list",
      data: [
        { ...RUN_SUMMARY, connection_id: "cin_1", connector_instance_id: "cin_1", browser_surface_status: "leased" },
      ],
      has_more: true,
      next_cursor: "opaque",
    });
    assert.equal(
      validateResponse(id, { status: 200, body: { object: "list", data: [], has_more: false, next_cursor: null } }).ok,
      false
    );
    assert.deepEqual(validateRequest(id, { query: { limit: "malformed", cursor: "malformed" } }), { ok: true });
  }
});

test("run timelines accept empty cursor pages and reject private storage fields", () => {
  for (const prefix of ["ref", "owner"]) {
    const id = `${prefix}GetRunTimeline`;
    expectResponse(id, 200, RUN_TIMELINE);
    expectResponse(id, 200, {
      ...RUN_TIMELINE,
      data: [RUN_EVENT],
      event_count: 1,
      next_cursor: "opaque",
      truncated: true,
    });
    for (const extra of [{ token_id: null }, { id: 42 }]) {
      assert.equal(
        validateResponse(id, { status: 200, body: { ...RUN_TIMELINE, data: [{ ...RUN_EVENT, ...extra }] } }).ok,
        false
      );
    }
    assert.deepEqual(validateRequest(id, { query: { limit: "" } }), { ok: true });
    assert.equal(validateRequest(id, { query: { limit: 5001 } }).ok, false);
    assert.equal(validateRequest(id, { query: { limit: 0 } }).ok, false);
    assert.deepEqual(validateRequest(id, { query: { limit: 5000, cursor: "opaque" } }), { ok: true });
  }
});

test("run controls validate acknowledgements without submitted data", () => {
  for (const prefix of ["ref", "owner"]) {
    expectResponse(`${prefix}CancelRun`, 202, {
      object: "run_cancel_ack",
      run_id: "run_1",
      status: "cancel_requested",
    });
    expectResponse(`${prefix}CancelRun`, 202, {
      object: "run_cancel_ack",
      run_id: "run_1",
      status: "scheduler_accepted",
    });
    for (const status of ["success", "cancelled"]) {
      const body = { object: "run_interaction_ack", run_id: "run_1", interaction_id: "int_1", status };
      expectResponse(`${prefix}RunInteraction`, 202, body);
      assert.equal(
        validateResponse(`${prefix}RunInteraction`, { status: 202, body: { ...body, data: { password: "secret" } } })
          .ok,
        false
      );
    }
  }
});

test("run auth distinguishes cookie session rejection from handler errors", () => {
  const cookieError = {
    error: {
      code: "owner_session_required",
      message: "Owner session required. Sign in at /owner/login.",
      type: "authentication_error",
    },
  };
  for (const [suffix] of RUN_ROUTES) {
    expectResponse(`ref${suffix}`, 401, cookieError);
    assert.equal(validateResponse(`owner${suffix}`, { status: 401, body: cookieError }).ok, false);
    expectResponse(`owner${suffix}`, 401, {
      error: {
        code: "invalid_token",
        message: "Invalid token",
        type: "authentication_error",
        request_id: "req_1",
        resource_metadata: "/metadata",
        next_step: "sign_in",
      },
    });
  }
});

test("run handlers require request IDs and use api_error for conflicts", () => {
  for (const prefix of ["ref", "owner"]) {
    for (const [suffix] of RUN_ROUTES) {
      for (const [status, type, code] of [
        [400, "invalid_request_error", "invalid_request"],
        [403, "permission_error", "run_owner_mismatch"],
        [404, "not_found_error", "not_found"],
        [409, "api_error", "no_pending_interaction"],
        [409, "api_error", "interaction_id_mismatch"],
        [409, "api_error", "run_already_terminal"],
        [500, "api_error", "api_error"],
      ] as const) {
        const error = { code, type, message: "Rejected", request_id: "req_1" };
        expectResponse(`${prefix}${suffix}`, status, { error });
        const { request_id: _requestId, ...missingRequestId } = error;
        assert.equal(validateResponse(`${prefix}${suffix}`, { status, body: { error: missingRequestId } }).ok, false);
      }
      assert.equal(
        validateResponse(`${prefix}${suffix}`, {
          status: 409,
          body: {
            error: { code: "no_pending_interaction", type: "conflict_error", message: "Rejected", request_id: "req_1" },
          },
        }).ok,
        false
      );
    }
  }
});

test("cookie connection projections share owner rows while bearer requires actions", () => {
  const { supported_actions: _actions, ...cookieRow } = OWNER_CONNECTION_ROW;
  for (const id of ["refListConnections", "refListConnectorInstances"]) {
    expectResponse(id, 200, { object: "list", data: [cookieRow] });
  }
  for (const id of ["refGetConnection", "refGetConnectorInstance", "refSetConnectionDisplayName"]) {
    expectResponse(id, 200, cookieRow);
    assert.equal(validateResponse(id, { status: 200, body: { ...cookieRow, object: "ref_connection" } }).ok, false);
  }
  assert.equal(
    validateResponse("ownerListConnections", { status: 200, body: { object: "list", data: [cookieRow] } }).ok,
    false
  );
  expectResponse("refRevokeConnection", 200, {
    object: "owner_connection_revoke",
    connection_id: "cin_1",
    connector_id: "amazon",
    connector_key: "amazon",
    status: "revoked",
    revoked_at: null,
  });
  expectResponse("refReactivateConnection", 200, {
    object: "owner_connection_reactivate",
    connection_id: "cin_1",
    connector_id: "amazon",
    connector_key: "amazon",
    status: "active",
    reactivated_at: "2026-10-10",
  });
});

// #348 shared revoke handler forwards BrowserProfilePurgeResult after the
// durable revoke. server/index.ts injects the purger on both owner surfaces.
test("connection revoke accepts all post-commit browser profile purge outcomes", () => {
  const revoked = {
    object: "owner_connection_revoke",
    connection_id: "cin_1",
    connector_id: "amazon",
    connector_key: "amazon",
    status: "revoked",
    revoked_at: "2026-10-10",
  };
  for (const id of ["refRevokeConnection", "ownerRevokeConnection", "ownerRevokeConnector"]) {
    expectResponse(id, 200, revoked);
    for (const target of ["host", "local"]) {
      for (const profile_purge of [
        { status: "purged", target, removed: 1 },
        { status: "absent", target },
        { status: "failed", target, error_code: "profile_purge_in_use", message: "Browser is still using the profile" },
      ]) {
        expectResponse(id, 200, { ...revoked, profile_purge });
      }
    }
    for (const profile_purge of [
      { status: "purged", target: "local" },
      { status: "failed", target: "host", error_code: "profile_purge_in_use" },
      { status: "absent", target: "other" },
      { status: "absent", target: "local", removed: 1 },
    ]) {
      assert.equal(validateResponse(id, { status: 200, body: { ...revoked, profile_purge } }).ok, false);
    }
  }
});
