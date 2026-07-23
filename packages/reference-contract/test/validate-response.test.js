// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { hasResponseSchema, validateResponse } from "../src/index.ts";

// `getRsDiscoveryIndex` is a stable JSON discovery operation whose
// declared 200 response schema does not drift from the reference
// implementation. These tests exercise validateResponse against that
// manifest because it is the canonical "exact-schema" candidate for
// the response-validation canary allowlist in the reference transport.

test("hasResponseSchema reports declared response statuses", () => {
  assert.equal(hasResponseSchema("getRsDiscoveryIndex", 200), true);
  // The discovery operation does not declare a 418 response.
  assert.equal(hasResponseSchema("getRsDiscoveryIndex", 418), false);
  // Unknown operation ids report no schema.
  assert.equal(hasResponseSchema("definitely-not-a-real-op", 200), false);
});

test("validateResponse passes a valid discovery envelope unchanged", () => {
  const payload = {
    links: {
      connectors: "/v1/connectors",
      core_query_base: "/v1",
      schema: "/v1/schema",
      well_known: "/.well-known/oauth-protected-resource",
    },
    object: "pdpp_discovery_index",
    reference_revision: "dev",
    resource_name: "PDPP Reference",
    role: "resource_server",
  };
  const before = JSON.stringify(payload);
  const result = validateResponse("getRsDiscoveryIndex", {
    body: payload,
    status: 200,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
  // Validation must not mutate the input payload.
  assert.equal(JSON.stringify(payload), before);
});

test("validateResponse reports skip with reason for unknown operation ids", () => {
  const result = validateResponse("definitely-not-a-real-op", {
    body: {},
    status: 200,
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "unknown_operation_id",
    skipped: true,
  });
});

test("validateResponse reports skip when no schema is declared for a status", () => {
  const result = validateResponse("getRsDiscoveryIndex", {
    body: undefined,
    status: 204,
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "no_schema_for_status",
    skipped: true,
  });
});

test("validateResponse fails closed when payload violates declared response schema", () => {
  // Missing required `links` field.
  const invalidPayload = {
    object: "pdpp_discovery_index",
    reference_revision: "dev",
    resource_name: "PDPP Reference",
    role: "resource_server",
  };
  const result = validateResponse("getRsDiscoveryIndex", {
    body: invalidPayload,
    status: 200,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
  // Each error carries a structured message — useful for operator logs
  // even though the wire envelope is intentionally opaque.
  for (const err of result.errors) {
    assert.equal(typeof err.message, "string");
  }
});

// `expand_capabilities` target-naming contract. Each entry SHALL carry both
// `target_stream` (the related child stream) and `child_parent_key_field` (the
// field on the child holding the parent's key). Pinned via getStreamMetadata's
// declared 200 response schema. See
//   openspec/changes/add-record-relationship-navigation/.

function streamMetadataWithExpandEntry(entry) {
  return {
    expand_capabilities: [entry],
    field_capabilities: {},
    name: "user",
    object: "stream_metadata",
  };
}

const VALID_EXPAND_ENTRY = {
  cardinality: "has_many",
  child_parent_key_field: "user_id",
  foreign_key: "user_id",
  granted: true,
  name: "user_stats",
  stream: "user_stats",
  target_stream: "user_stats",
  usable: true,
};

test("getStreamMetadata accepts an expand_capabilities entry carrying target_stream and child_parent_key_field", () => {
  const result = validateResponse("getStreamMetadata", {
    body: streamMetadataWithExpandEntry({ ...VALID_EXPAND_ENTRY }),
    status: 200,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test("getStreamMetadata rejects an expand_capabilities entry missing target_stream", () => {
  const entry = { ...VALID_EXPAND_ENTRY };
  delete entry.target_stream;
  const result = validateResponse("getStreamMetadata", {
    body: streamMetadataWithExpandEntry(entry),
    status: 200,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test("getStreamMetadata rejects an expand_capabilities entry missing child_parent_key_field", () => {
  const entry = { ...VALID_EXPAND_ENTRY };
  delete entry.child_parent_key_field;
  const result = validateResponse("getStreamMetadata", {
    body: streamMetadataWithExpandEntry(entry),
    status: 200,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test("getStreamMetadata rejects an expand_capabilities entry with an out-of-enum reason", () => {
  const result = validateResponse("getStreamMetadata", {
    body: streamMetadataWithExpandEntry({
      ...VALID_EXPAND_ENTRY,
      granted: false,
      reason: "not_a_declared_reason",
      usable: false,
    }),
    status: 200,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test("getStreamMetadata accepts each declared reason enum value on an inert entry", () => {
  for (const reason of ["related_stream_not_granted", "related_stream_unknown", "related_stream_not_loaded"]) {
    const result = validateResponse("getStreamMetadata", {
      body: streamMetadataWithExpandEntry({
        ...VALID_EXPAND_ENTRY,
        granted: false,
        reason,
        usable: false,
      }),
      status: 200,
    });
    assert.deepEqual(result, { ok: true, skipped: false }, `reason ${reason} should validate`);
  }
});
