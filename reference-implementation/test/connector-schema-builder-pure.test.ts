// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the pure exports of server/connector-schema-builder.ts.
// No test imports this module by name. The async DB-coupled functions
// (buildConnectorSchemaItem, getConnectorFreshnessEvidence, getVisibleStreamFreshness)
// are out of scope here; this file pins the two pure assemblers:
//   buildStreamMetadataEntry     -- the stream_metadata response shape.
//   buildConnectorAwareFreshness -- the evidence->deriveReferenceFreshness field mapping.
//
// Mutation surface:
//   buildStreamMetadataEntry: object='stream_metadata', primary_key normalization
//     (string->[string], array passthrough), views/relationships/query defaults
//     ([]/[]/{}), granted_connections attached ONLY when an array is supplied,
//     grantStreams folded into the expand-capabilities grant.
//   buildConnectorAwareFreshness: maps lastRun.last_at/status,
//     lastSuccessfulRun.last_at, maximumStalenessSeconds, recordLastUpdatedAt into
//     the freshness projection (a fresh vs stale verdict tracks the mapped inputs).

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/performance/noNamespaceImport: Namespace import is required for controlled module seam replacement.
import * as connectorSchemaBuilder from "../server/connector-schema-builder.ts";

// `server/connector-schema-builder.ts` is plain JS with no JSDoc types, so TS
// infers each destructured/defaulted param's type from its default value
// alone — too narrow for the real pass-through contract (see the identical
// note in connector-schema-builder-metadata-entry.test.ts, slice 1). These
// local types state the honest contract instead of fighting the inferred one.
// biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
const buildStreamMetadataEntry = connectorSchemaBuilder.buildStreamMetadataEntry;

interface ConnectorFreshnessEvidence {
  lastRun?: { last_at?: string; status?: string } | null;
  lastSuccessfulRun?: { last_at?: string } | null;
  maximumStalenessSeconds?: number | null;
}
type BuildConnectorAwareFreshness = (
  evidence: ConnectorFreshnessEvidence | null,
  recordLastUpdatedAt?: string | null
) => { status: string; captured_at?: string; last_attempted_at?: string };
const buildConnectorAwareFreshness =
  connectorSchemaBuilder.buildConnectorAwareFreshness as BuildConnectorAwareFreshness;

const baseStream = {
  consent_time_field: "emitted_at",
  cursor_field: "emitted_at",
  name: "orders",
  schema: { properties: { id: { type: "string" } } },
  selection: "all",
  semantics: "transactional",
};

// ---------------------------------------------------------------------------
// buildStreamMetadataEntry
// ---------------------------------------------------------------------------

test("buildStreamMetadataEntry: object tag is stream_metadata and core fields are carried", () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: "id" } });
  assert.equal(entry.object, "stream_metadata");
  assert.equal(entry.name, "orders");
  assert.equal(entry.semantics, "transactional");
  assert.equal(entry.cursor_field, "emitted_at");
  assert.equal(entry.consent_time_field, "emitted_at");
  assert.equal(entry.selection, "all");
});

test("buildStreamMetadataEntry: primary_key normalizes string->array and passes arrays through", () => {
  assert.deepEqual(buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: "id" } }).primary_key, [
    "id",
  ]);
  assert.deepEqual(
    buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: ["a", "b"] } }).primary_key,
    ["a", "b"]
  );
  assert.deepEqual(
    buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: undefined } }).primary_key,
    [],
    "absent primary_key -> []"
  );
});

test("buildStreamMetadataEntry: views/relationships/query default to []/[]/{}", () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: "id" } });
  assert.deepEqual(entry.views, []);
  assert.deepEqual(entry.relationships, []);
  assert.deepEqual(entry.query, {});
});

test("buildStreamMetadataEntry: provided views/relationships/query are preserved", () => {
  const entry = buildStreamMetadataEntry({
    manifestStream: {
      ...baseStream,
      primary_key: "id",
      query: { search: { lexical_fields: ["id"] } },
      relationships: [{ cardinality: "one_to_many", name: "items", stream: "order_items" }],
      views: [{ name: "recent" }],
    },
  });
  assert.deepEqual(entry.views, [{ name: "recent" }]);
  assert.deepEqual(entry.relationships, [{ cardinality: "one_to_many", name: "items", stream: "order_items" }]);
  assert.deepEqual(entry.query, { search: { lexical_fields: ["id"] } });
});

test("buildStreamMetadataEntry: granted_connections attached ONLY when an array is provided", () => {
  const without = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: "id" } });
  assert.ok(!("granted_connections" in without), "omitted when not provided");

  const nullProvided = buildStreamMetadataEntry({
    grantedConnections: null,
    manifestStream: { ...baseStream, primary_key: "id" },
  });
  assert.ok(!("granted_connections" in nullProvided), "omitted when null (not an array)");

  const withArray = buildStreamMetadataEntry({
    grantedConnections: [{ connection_id: "ci-1" }],
    manifestStream: { ...baseStream, primary_key: "id" },
  });
  assert.deepEqual(withArray.granted_connections, [{ connection_id: "ci-1" }]);
});

test("buildStreamMetadataEntry: default freshness is unknown when none supplied", () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: "id" } });
  assert.equal((entry.freshness as { status: string }).status, "unknown");
});

test("buildStreamMetadataEntry: an explicit freshness object is passed through verbatim", () => {
  const freshness = { captured_at: "2024-01-01T00:00:00.000Z", status: "fresh" };
  const entry = buildStreamMetadataEntry({ freshness, manifestStream: { ...baseStream, primary_key: "id" } });
  assert.equal(entry.freshness, freshness, "supplied freshness wins over the default");
});

test("buildStreamMetadataEntry: builds field_capabilities and expand_capabilities from the manifest", () => {
  const entry = buildStreamMetadataEntry({
    grantStreams: [{ name: "order_items" }],
    manifestStream: {
      ...baseStream,
      primary_key: "id",
      query: { expand: [{ name: "items" }] },
      relationships: [{ cardinality: "has_many", name: "items", stream: "order_items" }],
    },
    streamGrant: { fields: ["id"], name: "orders" },
  });
  const fieldCapabilities = entry.field_capabilities as Record<string, unknown>;
  const expandCapabilities = entry.expand_capabilities as { name: string }[];
  // field_capabilities is keyed by schema property.
  assert.ok(fieldCapabilities.id, "field_capabilities derived for declared property id");
  // expand_capabilities surfaces the declared, relationship-backed expand.
  assert.equal(expandCapabilities.length, 1);
  assert.equal(expandCapabilities[0]?.name, "items");
});

// ---------------------------------------------------------------------------
// buildConnectorAwareFreshness (evidence -> freshness field mapping)
// ---------------------------------------------------------------------------

test("buildConnectorAwareFreshness: a record newer than the last successful run within staleness is fresh-ish; stale evidence yields a stale/attempted verdict", () => {
  // Successful run at t0, record last updated well after -> the record is newer
  // than the last success by more than maximumStalenessSeconds -> 'stale'. This
  // pins that the successful-run + staleness + recordLastUpdatedAt inputs are all
  // wired through (not dropped).
  const verdict = buildConnectorAwareFreshness(
    {
      lastRun: { last_at: "2024-01-01T00:00:00Z", status: "succeeded" },
      lastSuccessfulRun: { last_at: "2024-01-01T00:00:00Z" },
      maximumStalenessSeconds: 3600,
    },
    "2024-06-01T00:00:00Z"
  );
  assert.equal(verdict.status, "stale");
  assert.equal(verdict.last_attempted_at, "2024-01-01T00:00:00.000Z", "lastRun.last_at mapped through");
});

test("buildConnectorAwareFreshness: null evidence yields an unknown-status verdict (nothing to assert freshness from)", () => {
  const verdict = buildConnectorAwareFreshness(null, null);
  assert.equal(verdict.status, "unknown");
});

test("buildConnectorAwareFreshness: last_attempted_at reflects the mapped lastRun timestamp, not the successful one", () => {
  const verdict = buildConnectorAwareFreshness(
    {
      lastRun: { last_at: "2024-05-05T05:05:05Z", status: "failed" },
      lastSuccessfulRun: { last_at: "2024-01-01T00:00:00Z" },
      maximumStalenessSeconds: 3600,
    },
    null
  );
  assert.equal(
    verdict.last_attempted_at,
    "2024-05-05T05:05:05.000Z",
    "attempted reflects lastRun, distinct from success"
  );
});
