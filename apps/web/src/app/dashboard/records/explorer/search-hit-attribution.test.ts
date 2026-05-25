import assert from "node:assert/strict";
import { test } from "node:test";
import type { RefConnectorSummary } from "../../lib/ref-client.ts";
import { attributeSearchHit } from "./search-hit-attribution.ts";

function summary(
  over: Partial<RefConnectorSummary> & { connection_id: string; connector_id: string }
): RefConnectorSummary {
  return {
    connection_health: {} as RefConnectorSummary["connection_health"],
    connection_id: over.connection_id,
    connector_display_name: over.connector_display_name,
    connector_id: over.connector_id,
    connector_instance_id: over.connector_instance_id,
    display_name: over.display_name ?? "",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: over.streams ?? [],
    total_records: 0,
  };
}

test("attributeSearchHit honors hit.connection_id when present", () => {
  const visible = [
    summary({ connection_id: "conn-personal", connector_id: "gmail", display_name: "Personal Gmail" }),
    summary({ connection_id: "conn-work", connector_id: "gmail", display_name: "Work Gmail" }),
  ];
  const result = attributeSearchHit(
    {
      connector_id: "gmail",
      connection_id: "conn-work",
    },
    visible
  );
  assert.equal(result.connectionId, "conn-work");
  assert.equal(result.connectionDisplayName, "Work Gmail");
});

test("attributeSearchHit accepts the deprecated connector_instance_id alias", () => {
  const visible = [
    summary({
      connection_id: "conn-personal",
      connector_id: "gmail",
      connector_instance_id: "ci-personal",
      display_name: "Personal Gmail",
    }),
  ];
  const result = attributeSearchHit({ connector_id: "gmail", connector_instance_id: "ci-personal" }, visible);
  assert.equal(result.connectionId, "conn-personal");
  assert.equal(result.connectionDisplayName, "Personal Gmail");
});

test("attributeSearchHit deduces the single visible connection of a connector type", () => {
  const visible = [summary({ connection_id: "conn-only", connector_id: "github", display_name: "the owner's GitHub" })];
  const result = attributeSearchHit({ connector_id: "github" }, visible);
  assert.equal(result.connectionId, "conn-only");
  assert.equal(result.connectionDisplayName, "the owner's GitHub");
});

test("attributeSearchHit refuses to pick an arbitrary first connection when ambiguous", () => {
  // Regression: the prior implementation grabbed `byConnectorId.get(hit.connector_id)`
  // and used the first matching summary as connection identity, falsely
  // attributing rows when two Gmail connections were visible.
  const visible = [
    summary({ connection_id: "conn-personal", connector_id: "gmail", display_name: "Personal Gmail" }),
    summary({ connection_id: "conn-work", connector_id: "gmail", display_name: "Work Gmail" }),
  ];
  const result = attributeSearchHit({ connector_id: "gmail" }, visible);
  assert.equal(result.connectionId, null);
  assert.equal(result.connectionDisplayName, null);
});

test("attributeSearchHit returns nulls when no matching connection is visible", () => {
  const visible = [summary({ connection_id: "conn-personal", connector_id: "gmail", display_name: "Personal Gmail" })];
  const result = attributeSearchHit({ connector_id: "github" }, visible);
  assert.equal(result.connectionId, null);
  assert.equal(result.connectionDisplayName, null);
});

test("attributeSearchHit prefers server-provided display_name over summary fallback", () => {
  const visible = [
    summary({ connection_id: "conn-personal", connector_id: "gmail", display_name: "Stale Local Name" }),
  ];
  const result = attributeSearchHit(
    {
      connector_id: "gmail",
      connection_id: "conn-personal",
      display_name: "Server Label",
    },
    visible
  );
  assert.equal(result.connectionId, "conn-personal");
  assert.equal(result.connectionDisplayName, "Server Label");
});
