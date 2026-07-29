// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure `buildStreamMetadataEntry`
 * composer in `server/connector-schema-builder.ts`. No test imports it by
 * name.
 *
 * It assembles the `stream_metadata` response object from a manifest stream:
 * the `object`/`name` tags, primary-key normalization, the
 * views/relationships/query DEFAULTING (`|| []` / `|| {}`), the freshness
 * fallback (`?? buildFreshness(null)`), and the CONDITIONAL
 * `granted_connections` (present only when an array is supplied).
 *
 * The defaulting and the conditional inclusion are the load-bearing bits: a
 * mutant that drops the `|| []` default (leaking `undefined` into the wire
 * shape) or unconditionally attaches `granted_connections` turns red here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildStreamMetadataEntry } from "../server/connector-schema-builder.ts";

// `server/connector-schema-builder.ts` is plain JS with no JSDoc types, so TS
// infers each destructured param's type from its default value alone (e.g.
// `freshness = null` infers as `null`) — too narrow for the real runtime
// contract, which accepts an opaque object for `freshness`/`grantedConnections`
// and passes it through untouched. This local type states that real contract
// honestly rather than fighting the narrower inferred type at each call site.

const BASE_STREAM = {
  consent_time_field: "received_at",
  cursor_field: "received_at",
  name: "messages",
  primary_key: ["message_id"],
  schema: { properties: { body: { type: "string" } }, type: "object" },
  selection: { mode: "all" },
  semantics: "append_only",
};

test("buildStreamMetadataEntry: tags, primary-key normalization, and views/relationships/query defaults", () => {
  const entry = buildStreamMetadataEntry({ manifestStream: BASE_STREAM });

  assert.equal(entry.object, "stream_metadata");
  assert.equal(entry.name, "messages");
  assert.equal(entry.semantics, "append_only");
  assert.deepEqual(entry.primary_key, ["message_id"]);
  assert.equal(entry.cursor_field, "received_at");

  // Missing views / relationships / query default to [] / [] / {} (never undefined).
  assert.deepEqual(entry.views, []);
  assert.deepEqual(entry.relationships, []);
  assert.deepEqual(entry.query, {});

  // A freshness envelope is always present (the ?? fallback), even with no input.
  assert.equal(typeof entry.freshness, "object", "freshness must default to an object");

  // No grantedConnections supplied -> the key is absent entirely.
  assert.ok(!("granted_connections" in entry), "granted_connections must be omitted when not an array");
});

test("buildStreamMetadataEntry: passes through declared views/relationships/query and explicit freshness", () => {
  const stream = {
    ...BASE_STREAM,
    query: { search: { lexical_fields: ["body"] } },
    relationships: [{ cardinality: "one_to_many", name: "thread", stream: "threads" }],
    views: [{ name: "recent" }],
  };
  const freshness = { as_of: "2026-03-01T00:00:00Z", state: "fresh" };
  const entry = buildStreamMetadataEntry({ freshness, manifestStream: stream });

  assert.deepEqual(entry.views, [{ name: "recent" }]);
  assert.deepEqual(entry.relationships, [{ cardinality: "one_to_many", name: "thread", stream: "threads" }]);
  assert.deepEqual(entry.query, { search: { lexical_fields: ["body"] } });
  // Explicit freshness wins over the fallback.
  assert.deepEqual(entry.freshness, freshness);

  // field_capabilities / expand_capabilities are always computed.
  assert.equal(typeof entry.field_capabilities, "object");
  assert.ok(Array.isArray(entry.expand_capabilities));
});

test("buildStreamMetadataEntry: attaches granted_connections ONLY when an array is provided", () => {
  const conns = [{ connection_id: "cin_1", display_name: "Work" }];
  const withConns = buildStreamMetadataEntry({ grantedConnections: conns, manifestStream: BASE_STREAM });
  assert.deepEqual(withConns.granted_connections, conns);

  // A non-array (null) grantedConnections -> key omitted.
  const withNull = buildStreamMetadataEntry({ grantedConnections: null, manifestStream: BASE_STREAM });
  assert.ok(!("granted_connections" in withNull));
});

test("buildStreamMetadataEntry: normalizes a scalar primary_key into an array", () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...BASE_STREAM, primary_key: "id" } });
  assert.deepEqual(entry.primary_key, ["id"], "scalar primary_key must normalize to a one-element array");
});
