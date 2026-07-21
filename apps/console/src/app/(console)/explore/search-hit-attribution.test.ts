// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeSearchHit, shouldIncludeSearchHit } from "@pdpp/operator-ui/explore/search-hit-attribution";
import type { RefConnectorSummary } from "../lib/ref-client.ts";

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
  const visible = [summary({ connection_id: "conn-only", connector_id: "github", display_name: "Tim's GitHub" })];
  const result = attributeSearchHit({ connector_id: "github" }, visible);
  assert.equal(result.connectionId, "conn-only");
  assert.equal(result.connectionDisplayName, "Tim's GitHub");
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

test("shouldIncludeSearchHit drops a hit whose concrete connection identity is not selected", () => {
  // Regression for the post-revision-1 review: when a forward-compatible
  // RS returns `connection_id` on a search hit AND the owner has selected
  // a specific Gmail connection, a hit from the *other* Gmail connection
  // must NOT slip through just because both share `connector_id: gmail`.
  const allowedConnectors = new Set(["gmail"]);
  // `conn-personal` is the only selected/visible connection; `conn-work`
  // is filtered out at the summaries layer and so is not in this set.
  const allowedConnectionIds = new Set(["conn-personal"]);
  const hit = {
    connector_id: "gmail",
    connection_id: "conn-work",
  };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: true,
    }),
    false
  );
});

test("shouldIncludeSearchHit keeps a hit whose concrete connection identity matches the selection", () => {
  const allowedConnectors = new Set(["gmail"]);
  const allowedConnectionIds = new Set(["conn-personal"]);
  const hit = {
    connector_id: "gmail",
    connection_id: "conn-personal",
  };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: true,
    }),
    true
  );
});

test("shouldIncludeSearchHit honors the deprecated connector_instance_id alias when filtering", () => {
  const allowedConnectors = new Set(["gmail"]);
  const allowedConnectionIds = new Set(["conn-personal", "ci-personal"]);
  const hit = {
    connector_id: "gmail",
    connector_instance_id: "ci-work",
  };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: true,
    }),
    false
  );
});

test("shouldIncludeSearchHit falls through to connector-scope when the hit carries no connection identity", () => {
  // Today's deployed RS does not emit connection_id on search hits. In
  // that case we cannot tighten beyond connector_id; the helper must let
  // the hit through and the row renders connector-scoped.
  const allowedConnectors = new Set(["gmail"]);
  const allowedConnectionIds = new Set(["conn-personal"]);
  const hit = { connector_id: "gmail" };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: true,
    }),
    true
  );
});

test("shouldIncludeSearchHit drops hits whose connector type is not in the visible set", () => {
  const allowedConnectors = new Set(["gmail"]);
  const allowedConnectionIds = new Set(["conn-personal"]);
  const hit = { connector_id: "github", connection_id: "conn-personal" };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: true,
    }),
    false
  );
});

test("shouldIncludeSearchHit does not enforce connection-scope when no chips are selected", () => {
  // `enforceConnectionFilter: false` mirrors the no-chip state in the
  // page; we must not start dropping rows just because a hit happens to
  // carry an unrecognized connection_id.
  const allowedConnectors = new Set(["gmail"]);
  const allowedConnectionIds = new Set<string>();
  const hit = { connector_id: "gmail", connection_id: "conn-unknown" };
  assert.equal(
    shouldIncludeSearchHit(hit, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter: false,
    }),
    true
  );
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
