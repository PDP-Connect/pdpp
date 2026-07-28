// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the schema-capability PROJECTION functions in
// server/schema-capabilities.js. No test imports this module by name today; all
// three exports (buildFieldCapabilities, buildExpandCapabilities,
// buildStreamDiscoveryCapabilities) were unpinned at the unit level.
//
// The route-level query-contract.test.js asserts related_stream_not_granted
// through the HTTP surface; this file pins the projection directly and, in
// particular, the related_stream_unknown branch (known ? not_granted : unknown)
// which had ZERO coverage anywhere.

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

function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an entry at index ${index}`);
  return item;
}

// ---------------------------------------------------------------------------
// buildFieldCapabilities: granted flag + usable derivation + reason
// ---------------------------------------------------------------------------

function streamWith(properties: unknown, extras: Record<string, unknown> = {}) {
  return { schema: { properties }, ...extras };
}

test("buildFieldCapabilities: scalar field is exact_filterable when declared", () => {
  const caps = buildFieldCapabilities(streamWith({ status: { type: "string" } }));
  const status = field(caps, "status");
  assert.equal((status.exact_filter as Record<string, unknown>).declared, true);
  assert.equal(status.granted, true, "no grant scoping -> granted");
  assert.equal((status.exact_filter as Record<string, unknown>).usable, true);
});

test("buildFieldCapabilities: object-typed field is NOT exact_filterable", () => {
  const caps = buildFieldCapabilities(streamWith({ payload: { type: "object" } }));
  const payload = field(caps, "payload");
  assert.equal(
    (payload.exact_filter as Record<string, unknown>).declared,
    false,
    "non-scalar cannot be exact-filtered"
  );
});

test("buildFieldCapabilities: ungranted field is declared-but-not-usable with field_not_granted reason", () => {
  const caps = buildFieldCapabilities(
    streamWith({ secret: { type: "string" }, status: { type: "string" } }),
    { fields: ["status"] } // grant only exposes `status`
  );
  const status = field(caps, "status");
  const secret = field(caps, "secret");
  assert.equal(status.granted, true);
  assert.equal(secret.granted, false);
  const secretExactFilter = secret.exact_filter as Record<string, unknown>;
  assert.equal(secretExactFilter.declared, true, "schema still declares it filterable");
  assert.equal(secretExactFilter.usable, false, "but not usable without grant");
  assert.equal(secretExactFilter.reason, "field_not_granted");
});

test("buildFieldCapabilities: range_filter surfaces declared operators from manifest", () => {
  const caps = buildFieldCapabilities(
    streamWith({ amount: { type: "integer" } }, { query: { range_filters: { amount: ["gte", "lte"] } } })
  );
  const amount = field(caps, "amount");
  const amountRangeFilter = amount.range_filter as Record<string, unknown>;
  assert.equal(amountRangeFilter.declared, true);
  assert.deepEqual(amountRangeFilter.operators, ["gte", "lte"]);
});

test("buildFieldCapabilities: aggregation flags reflect declared sum/group_by membership", () => {
  const caps = buildFieldCapabilities(
    streamWith(
      { amount: { type: "number" }, category: { type: "string" } },
      {
        query: { aggregations: { group_by: ["category"], sum: ["amount"] } },
      }
    )
  );
  const amount = field(caps, "amount");
  const category = field(caps, "category");
  const amountAggregation = amount.aggregation as Record<string, Record<string, unknown> | undefined>;
  const categoryAggregation = category.aggregation as Record<string, Record<string, unknown> | undefined>;
  assert.equal(amountAggregation.sum?.declared, true);
  assert.equal(amountAggregation.group_by?.declared, false);
  assert.equal(categoryAggregation.group_by?.declared, true);
  assert.equal(categoryAggregation.sum?.declared, false);
});

// ---------------------------------------------------------------------------
// buildExpandCapabilities: reachability projection (the two reason codes)
// ---------------------------------------------------------------------------

function expandStream() {
  return {
    query: { expand: [{ default_limit: 10, max_limit: 25, name: "items" }] },
    relationships: [{ cardinality: "has_many", foreign_key: "order_id", name: "items", stream: "order_items" }],
  };
}

test("buildExpandCapabilities: usable entry when target stream is known and granted", () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: "order_items" }] },
    new Set(["orders", "order_items"])
  );
  assert.equal(out.length, 1);
  const items = at(out, 0);
  assert.equal(items.name, "items");
  assert.equal(items.target_stream, "order_items");
  assert.equal(items.stream, "order_items", "back-compat alias present");
  assert.equal(items.cardinality, "has_many");
  assert.equal(items.child_parent_key_field, "order_id");
  assert.equal(items.foreign_key, "order_id", "back-compat alias");
  assert.equal(items.granted, true);
  assert.equal(items.usable, true);
  assert.equal(items.reason, undefined, "usable entries carry no reason");
});

test("buildExpandCapabilities: known-but-not-granted -> reason related_stream_not_granted", () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: "something_else" }] }, // order_items NOT granted
    new Set(["orders", "order_items"]) // but it IS in the manifest (known)
  );
  const items = at(out, 0);
  assert.equal(items.usable, false);
  assert.equal(items.granted, false);
  assert.equal(items.reason, "related_stream_not_granted");
});

test("buildExpandCapabilities: unknown target stream -> reason related_stream_unknown", () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: "order_items" }] }, // grant would allow it
    new Set(["orders"]) // but order_items is NOT in the loaded manifest (unknown)
  );
  const items = at(out, 0);
  assert.equal(items.usable, false);
  assert.equal(items.reason, "related_stream_unknown", "unknown target must be distinguished from not_granted");
});

test("buildExpandCapabilities: capability without a backing relationship is dropped", () => {
  const stream = {
    query: { expand: [{ name: "items" }] },
    relationships: [], // no relationship backs the 'items' capability
  };
  const out = buildExpandCapabilities(stream, null, null);
  assert.deepEqual(out, [], "unbacked capability filtered out");
});

test("buildExpandCapabilities: null grant + null manifest names => everything known is granted", () => {
  const out = buildExpandCapabilities(expandStream(), null, null);
  const items = at(out, 0);
  assert.equal(items.granted, true, "no grant scoping => granted");
  assert.equal(items.usable, true);
});

// ---------------------------------------------------------------------------
// buildStreamDiscoveryCapabilities: URL + boolean projection
// ---------------------------------------------------------------------------

test("buildStreamDiscoveryCapabilities: aggregate flag/url present only when aggregations declared", () => {
  const withAgg = buildStreamDiscoveryCapabilities({
    connectorId: "amazon",
    stream: { name: "orders", query: { aggregations: { sum: ["total"] } } },
  });
  assert.equal(withAgg.aggregate, true);
  assert.equal(withAgg.aggregate_url, "/v1/streams/orders/aggregate?connector_id=amazon");

  // hasObjectEntries short-circuits on a falsy input, so an ABSENT aggregations
  // key yields a falsy `undefined` (not a literal false); the aggregate_url is
  // still null. Pin both so a mutant that hard-codes aggregate:true is caught.
  const noAgg = buildStreamDiscoveryCapabilities({ connectorId: "amazon", stream: { name: "orders", query: {} } });
  assert.ok(!noAgg.aggregate, "absent aggregations -> falsy aggregate flag");
  assert.equal(noAgg.aggregate_url, null, "no aggregate URL when no aggregations");
  // An explicit EMPTY aggregations object also yields a falsy flag.
  const emptyAgg = buildStreamDiscoveryCapabilities({ stream: { name: "orders", query: { aggregations: {} } } });
  assert.equal(emptyAgg.aggregate, false, "empty aggregations object -> false");
  assert.equal(emptyAgg.aggregate_url, null);
});

test("buildStreamDiscoveryCapabilities: range_filters flag reflects non-empty declaration", () => {
  const withRange = buildStreamDiscoveryCapabilities({
    stream: { name: "orders", query: { range_filters: { total: ["gte"] } } },
  });
  assert.equal(withRange.range_filters, true);
  const noRange = buildStreamDiscoveryCapabilities({ stream: { name: "orders", query: { range_filters: {} } } });
  assert.equal(noRange.range_filters, false, "empty range_filters object is not a capability");
});

test("buildStreamDiscoveryCapabilities: expand flag true only for a non-empty expand array", () => {
  const withExpand = buildStreamDiscoveryCapabilities({
    stream: { name: "orders", query: { expand: [{ name: "items" }] } },
  });
  assert.equal(withExpand.expand, true);
  const emptyExpand = buildStreamDiscoveryCapabilities({ stream: { name: "orders", query: { expand: [] } } });
  assert.equal(emptyExpand.expand, false);
});

test("buildStreamDiscoveryCapabilities: encodes stream name and omits connector query when no connector", () => {
  const caps = buildStreamDiscoveryCapabilities({ stream: { name: "weird/name", query: {} } });
  assert.equal(caps.metadata_url, "/v1/streams/weird%2Fname", "stream name URL-encoded, no connector query");
  assert.equal(caps.records_url, "/v1/streams/weird%2Fname/records");
  assert.equal(caps.stream_metadata, true);
  assert.equal(caps.records, true);
  assert.equal(caps.changes_since, true);
  assert.equal(caps.exact_filters, true);
});
