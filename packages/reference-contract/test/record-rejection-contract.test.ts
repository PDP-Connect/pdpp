// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateRequest, validateResponse } from "../src/index.ts";

const metadata = {
  connection_id: "connection-1",
  connector_id: "connector-1",
  created_at: "2026-08-11T20:00:00.000Z",
  first_input_index: 1,
  last_seen_at: "2026-08-11T20:01:00.000Z",
  latest_input_index: 1,
  payload_bytes: 21,
  payload_sha256: "a".repeat(64),
  reason_code: "invalid_record_identity",
  receipt_id: "rr_opaque",
  replay_count: 0,
  run_id: "run-1",
  status: "pending",
  stream: "items",
};

test("record-rejection contracts bind connection and receipt path parameters", () => {
  assert.deepEqual(
    validateRequest("refListRecordRejections", {
      params: { connectorInstanceId: "connection-1" },
      query: { cursor: "opaque", limit: 25 },
    }),
    { ok: true }
  );
  assert.deepEqual(
    validateRequest("refGetRecordRejection", {
      params: { connectorInstanceId: "connection-1", receiptId: "rr_opaque" },
    }),
    { ok: true }
  );
});

test("record-rejection list contract admits metadata and rejects payload disclosure", () => {
  const list = {
    data: [metadata],
    has_more: false,
    next_cursor: null,
    object: "list",
  };
  assert.deepEqual(validateResponse("refListRecordRejections", { body: list, status: 200 }), {
    ok: true,
    skipped: false,
  });
  const disclosed = { ...list, data: [{ ...metadata, payload_text: '{"id":"bad"}' }] };
  assert.equal(validateResponse("refListRecordRejections", { body: disclosed, status: 200 }).ok, false);
});

test("record-rejection detail contract returns the exact retained payload field", () => {
  const detail = { ...metadata, payload_text: '{"id":"bad"}' };
  assert.deepEqual(validateResponse("refGetRecordRejection", { body: detail, status: 200 }), {
    ok: true,
    skipped: false,
  });
  const { payload_text: _payloadText, ...missingPayload } = detail;
  assert.equal(validateResponse("refGetRecordRejection", { body: missingPayload, status: 200 }).ok, false);
});
