// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the schema read-model capability builders
// (server/schema-capabilities.js) that the MCP `schema` tool advertises.
// buildExpandCapabilities and buildStreamDiscoveryCapabilities are pure
// shape-assembly (the expand builder was explicitly decomplected so its
// reachability inputs are passed, not captured) yet have ZERO by-name coverage.
// They emit the public `related_stream_not_granted` / `related_stream_unknown`
// reason enums and the discovery URL/flags a console reads. No DB.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpandCapabilities as buildExpandCapabilitiesUntyped,
  buildStreamDiscoveryCapabilities as buildStreamDiscoveryCapabilitiesUntyped,
} from "../server/schema-capabilities.ts";

// Both imports carry a `= null` default-parameter type in their untyped JS
// declarations (server/schema-capabilities.js), which TS infers as the
// parameter's whole type even though the real runtime contract accepts the
// documented object shape too, as every call below proves.
type BuildExpandCapabilities = (
  manifestStream: unknown,
  streamGrant?: { grantStreams: { name: string }[] } | null,
  manifestStreamNames?: Set<string> | null
) => Record<string, unknown>[];

type BuildStreamDiscoveryCapabilities = (args: {
  connectorId?: string | null;
  stream: { name: string; query?: Record<string, unknown> };
}) => Record<string, unknown>;

const buildExpandCapabilities = buildExpandCapabilitiesUntyped as BuildExpandCapabilities;
const buildStreamDiscoveryCapabilities = buildStreamDiscoveryCapabilitiesUntyped as BuildStreamDiscoveryCapabilities;

function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an entry at index ${index}`);
  return item;
}

test("buildExpandCapabilities emits usable/granted/reason per relation reachability", () => {
  const manifestStream = {
    query: {
      expand: [
        { default_limit: 10, max_limit: 50, name: "account" },
        { name: "stmt" },
        { name: "ghost" },
        { name: "undeclared_rel" }, // no backing relationship -> filtered out
      ],
    },
    relationships: [
      { cardinality: "many_to_one", foreign_key: "account_id", name: "account", stream: "accounts" },
      { cardinality: "one_to_many", name: "stmt", stream: "statements" },
      { cardinality: "one_to_many", name: "ghost", stream: "ghosts" },
    ],
  };
  const grant = { grantStreams: [{ name: "accounts" }] }; // only accounts granted
  const manifestStreamNames = new Set(["accounts", "statements"]); // ghosts is unknown

  const caps = buildExpandCapabilities(manifestStream, grant, manifestStreamNames);

  // undeclared_rel (no relationship) is dropped; the three backed relations remain.
  assert.equal(caps.length, 3);

  // Granted + known -> usable, with the foreign-key canonical + alias and limits.
  assert.deepEqual(caps[0], {
    cardinality: "many_to_one",
    child_parent_key_field: "account_id",
    default_limit: 10,
    foreign_key: "account_id",
    granted: true,
    max_limit: 50,
    name: "account",
    stream: "accounts",
    target_stream: "accounts",
    usable: true,
  });

  // Known but not granted -> related_stream_not_granted.
  const stmt = at(caps, 1);
  assert.equal(stmt.name, "stmt");
  assert.equal(stmt.granted, false);
  assert.equal(stmt.usable, false);
  assert.equal(stmt.reason, "related_stream_not_granted");
  assert.ok(!("foreign_key" in stmt), "a relation without a foreign_key omits it");

  // Unknown target stream -> related_stream_unknown.
  const ghost = at(caps, 2);
  assert.equal(ghost.name, "ghost");
  assert.equal(ghost.usable, false);
  assert.equal(ghost.reason, "related_stream_unknown");
});

test("buildExpandCapabilities: a null grant (owner/unfiltered) makes every known relation usable", () => {
  const manifestStream = {
    query: { expand: [{ name: "account" }] },
    relationships: [{ cardinality: "many_to_one", name: "account", stream: "accounts" }],
  };
  // grant=null, manifestStreamNames=null => no scoping in effect.
  const caps = buildExpandCapabilities(manifestStream, null, null);
  assert.equal(caps.length, 1);
  const account = at(caps, 0);
  assert.equal(account.granted, true);
  assert.equal(account.usable, true);
  assert.ok(!("reason" in account), "a usable relation carries no reason");
});

test("buildStreamDiscoveryCapabilities encodes the stream, scopes URLs by connector, and reflects query flags", () => {
  const caps = buildStreamDiscoveryCapabilities({
    connectorId: "c1",
    stream: {
      name: "ord ers",
      query: { aggregations: { count: ["x"] }, expand: [{ name: "r" }], range_filters: { amount: ["gte"] } },
    },
  });
  assert.equal(caps.metadata_url, "/v1/streams/ord%20ers?connector_id=c1");
  assert.equal(caps.records_url, "/v1/streams/ord%20ers/records?connector_id=c1");
  assert.equal(caps.aggregate, true);
  assert.equal(caps.aggregate_url, "/v1/streams/ord%20ers/aggregate?connector_id=c1");
  assert.equal(caps.range_filters, true);
  assert.equal(caps.expand, true);
  assert.equal(caps.exact_filters, true);
  assert.equal(caps.changes_since, true);
});

test("buildStreamDiscoveryCapabilities omits the connector query and nulls aggregate_url when unsupported", () => {
  const caps = buildStreamDiscoveryCapabilities({ stream: { name: "plain" } });
  assert.equal(caps.metadata_url, "/v1/streams/plain"); // no ?connector_id
  // hasObjectEntries(undefined) short-circuits to a falsy undefined (not false)
  // when the stream declares no aggregations/range_filters.
  assert.ok(!caps.aggregate);
  assert.equal(caps.aggregate_url, null);
  assert.ok(!caps.range_filters);
  assert.equal(caps.expand, false); // expand uses Array.isArray(...) && length>0 => strict false
});
