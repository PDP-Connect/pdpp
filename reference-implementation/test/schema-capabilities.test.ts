// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure schema-capability projection helpers.
 *
 * schema-capabilities.js is a pure module (no I/O) but had no co-named test
 * and none of its exports were touched elsewhere. These tests OBSERVE the
 * grant-derived capability flags without changing behavior. Coverage:
 *   - buildFieldCapabilities: exact/range/lexical/semantic/aggregation
 *     declared+usable flags, the field_not_granted reason, x_pdpp_type/role
 *     projection, and range operator surfacing,
 *   - buildExpandCapabilities: usable vs declared-unreadable relations with
 *     the related_stream_not_granted / related_stream_unknown reasons and the
 *     canonical + back-compat field aliases,
 *   - buildStreamDiscoveryCapabilities: URL construction, connector_id query
 *     encoding, and the aggregate/range/expand presence flags.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpandCapabilities as buildExpandCapabilitiesUntyped,
  buildFieldCapabilities as buildFieldCapabilitiesUntyped,
  buildStreamDiscoveryCapabilities as buildStreamDiscoveryCapabilitiesUntyped,
} from "../server/schema-capabilities.ts";

// These imports carry a `= null` default-parameter type in their untyped JS
// declarations (server/schema-capabilities.js), which TS infers as the
// parameter's whole type even though the real runtime contract accepts the
// documented object shape too, as every call below proves.
type BuildFieldCapabilities = (
  manifestStream: unknown,
  streamGrant?: { fields: string[] } | null
) => Record<string, Record<string, unknown>>;

type BuildExpandCapabilities = (
  manifestStream: unknown,
  streamGrant?: { grantStreams: { name: string }[] } | null,
  manifestStreamNames?: Set<string> | null
) => Record<string, unknown>[];

type BuildStreamDiscoveryCapabilities = (args: {
  connectorId?: string | null;
  stream: { name: string; query?: Record<string, unknown> };
}) => Record<string, unknown>;

const buildFieldCapabilities = buildFieldCapabilitiesUntyped as BuildFieldCapabilities;
const buildExpandCapabilities = buildExpandCapabilitiesUntyped as BuildExpandCapabilities;
const buildStreamDiscoveryCapabilities = buildStreamDiscoveryCapabilitiesUntyped as BuildStreamDiscoveryCapabilities;

function field(caps: Record<string, Record<string, unknown>>, name: string): Record<string, unknown> {
  const entry = caps[name];
  assert.ok(entry, `capability entry for "${name}" SHALL exist`);
  return entry;
}

function findCapability(caps: Record<string, unknown>[], name: string): Record<string, unknown> | undefined {
  return caps.find((c) => c.name === name);
}

function requireCapability(caps: Record<string, unknown>[], name: string): Record<string, unknown> {
  const entry = findCapability(caps, name);
  assert.ok(entry, `expand capability "${name}" SHALL exist`);
  return entry;
}

function streamFixture() {
  return {
    name: "messages",
    query: {
      aggregations: { count: true, group_by: ["priority"], min: ["sent_at"], sum: ["priority"] },
      range_filters: { sent_at: ["gte", "lte"] },
      search: { lexical_fields: ["subject"], semantic_fields: ["subject"] },
    },
    schema: {
      properties: {
        priority: { type: "integer" },
        sent_at: { format: "date-time", type: "string" },
        subject: { type: "string", x_pdpp_role: "title", x_pdpp_type: "headline" },
      },
    },
  };
}

test("buildFieldCapabilities marks exact-filterable scalar fields declared+usable when granted", () => {
  const caps = buildFieldCapabilities(streamFixture());
  const subject = field(caps, "subject");
  const sentAt = field(caps, "sent_at");
  assert.equal((subject.exact_filter as Record<string, unknown>).declared, true);
  assert.equal((subject.exact_filter as Record<string, unknown>).usable, true);
  // Range declared only where range_filters lists the field, with operators surfaced.
  assert.equal((sentAt.range_filter as Record<string, unknown>).declared, true);
  assert.deepEqual((sentAt.range_filter as Record<string, unknown>).operators, ["gte", "lte"]);
  assert.equal((subject.range_filter as Record<string, unknown>).declared, false);
});

test("buildFieldCapabilities projects lexical/semantic/aggregation declarations", () => {
  const caps = buildFieldCapabilities(streamFixture());
  const subject = field(caps, "subject");
  const priority = field(caps, "priority");
  const sentAt = field(caps, "sent_at");
  assert.equal((subject.lexical_search as Record<string, unknown>).declared, true);
  assert.equal((subject.semantic_search as Record<string, unknown>).declared, true);
  const priorityAggregation = priority.aggregation as Record<string, Record<string, unknown> | undefined>;
  assert.equal(priorityAggregation.sum?.declared, true);
  assert.equal(priorityAggregation.group_by?.declared, true);
  assert.equal(priorityAggregation.max?.declared, false);
  assert.equal((sentAt.aggregation as Record<string, Record<string, unknown> | undefined>).min?.declared, true);
});

test("buildFieldCapabilities surfaces x_pdpp_type/role on the entry", () => {
  const caps = buildFieldCapabilities(streamFixture());
  const subject = field(caps, "subject");
  const priority = field(caps, "priority");
  assert.equal(subject.type, "headline");
  assert.equal(subject.role, "title");
  // Fields without the extension omit type/role.
  assert.equal("type" in priority, false);
  assert.equal("role" in priority, false);
});

test("buildFieldCapabilities applies field_not_granted when the grant omits a field", () => {
  const grant = { fields: ["subject"] }; // sent_at, priority not granted
  const caps = buildFieldCapabilities(streamFixture(), grant);
  const subject = field(caps, "subject");
  const sentAt = field(caps, "sent_at");
  const priority = field(caps, "priority");
  assert.equal(subject.granted, true);
  assert.equal(sentAt.granted, false);
  assert.equal(sentAt.exact_filter, undefined);
  assert.equal(sentAt.range_filter, undefined);
  const priorityAggregation = priority.aggregation as Record<string, Record<string, unknown> | undefined>;
  assert.equal(priorityAggregation.sum?.usable, false);
  assert.equal(priorityAggregation.sum?.reason, "field_not_granted");
});

function expandStreamFixture() {
  return {
    query: {
      expand: [
        { default_limit: 10, max_limit: 25, name: "items" },
        { name: "buyer" },
        { name: "ghost" },
        { name: "no_relationship" }, // capability with no backing relationship -> filtered out
      ],
    },
    relationships: [
      { cardinality: "has_many", foreign_key: "order_id", name: "items", stream: "order_items" },
      { cardinality: "has_one", name: "buyer", stream: "people" },
      { cardinality: "has_one", name: "ghost", stream: "nonexistent" },
    ],
  };
}

test("buildExpandCapabilities returns usable relations and back-compat aliases", () => {
  const caps = buildExpandCapabilities(expandStreamFixture());
  const items = requireCapability(caps, "items");
  assert.equal(items.usable, true);
  assert.equal(items.stream, "order_items");
  assert.equal(items.target_stream, "order_items");
  assert.equal(items.child_parent_key_field, "order_id");
  assert.equal(items.foreign_key, "order_id");
  assert.equal(items.default_limit, 10);
  assert.equal(items.max_limit, 25);
  // The capability with no backing relationship is dropped.
  assert.equal(findCapability(caps, "no_relationship"), undefined);
});

test("buildExpandCapabilities reasons: related_stream_not_granted vs related_stream_unknown", () => {
  const manifestStreamNames = new Set(["order_items", "people"]);
  const streamGrant = { grantStreams: [{ name: "people" }] }; // order_items known but not granted
  const caps = buildExpandCapabilities(expandStreamFixture(), streamGrant, manifestStreamNames);

  const items = requireCapability(caps, "items");
  assert.equal(items.granted, false);
  assert.equal(items.usable, false);
  assert.equal(items.reason, "related_stream_not_granted");

  const buyer = requireCapability(caps, "buyer");
  assert.equal(buyer.usable, true);

  const ghost = requireCapability(caps, "ghost");
  assert.equal(ghost.usable, false);
  assert.equal(ghost.reason, "related_stream_unknown");
});

test("buildStreamDiscoveryCapabilities builds URLs and presence flags", () => {
  const stream = streamFixture();
  const caps = buildStreamDiscoveryCapabilities({ stream });
  assert.equal(caps.metadata_url, "/v1/streams/messages");
  assert.equal(caps.records_url, "/v1/streams/messages/records");
  assert.equal(caps.aggregate, true);
  assert.equal(caps.aggregate_url, "/v1/streams/messages/aggregate");
  assert.equal(caps.range_filters, true);
  assert.equal(caps.expand, false); // no query.expand in this fixture
  assert.equal(caps.changes_since, true);
});

test("buildStreamDiscoveryCapabilities encodes connector_id and omits aggregate_url without aggregations", () => {
  const stream = { name: "a b", query: {} };
  const caps = buildStreamDiscoveryCapabilities({ connectorId: "gmail/x", stream });
  assert.equal(caps.metadata_url, "/v1/streams/a%20b?connector_id=gmail%2Fx");
  // hasObjectEntries short-circuits to a falsy value when query has no
  // aggregations/range_filters object; assert falsy, matching real behavior.
  assert.ok(!caps.aggregate);
  assert.equal(caps.aggregate_url, null);
  assert.ok(!caps.range_filters);
});
