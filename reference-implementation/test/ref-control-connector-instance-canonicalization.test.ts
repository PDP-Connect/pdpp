// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `getConnectorSummaryForRoute` (via its internal
 * `resolveOwnerVisibleConnectionForRoute` helper) must resolve a grouped
 * fragment's own connector_instance_id route to its CANONICAL sibling's
 * connection summary — one logical account, one detail page — rather than
 * rendering the fragment's own identity. An ungrouped connector instance
 * (the GitHub-shape case) must resolve to itself, unaffected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exec } from "../lib/db.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { referenceQueries } from "../server/queries/index.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";

const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-08-15T00:00:00.000Z";

function seedManifestConnector(connectorId: string): void {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId: string, connectorId: string, displayName: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER_SUBJECT_ID, connectorId, displayName, connectorInstanceId, NOW, NOW);
}

function groupFragment(connectorInstanceId: string, canonicalConnectorInstanceId: string): void {
  exec(referenceQueries.connectorInstanceGroupsUpsert, [
    connectorInstanceId,
    canonicalConnectorInstanceId,
    OWNER_SUBJECT_ID,
    "proven_subset",
    "{}",
    "test-actor",
    NOW,
  ]);
}

test("a grouped fragment's route resolves to its canonical sibling's connection summary", async () => {
  initDb();
  try {
    seedManifestConnector("amazon_route_canon_xsurface");
    seedInstance("cin_route_canonical", "amazon_route_canon_xsurface", "Amazon");
    seedInstance("cin_route_fragment", "amazon_route_canon_xsurface", "Amazon (fragment)");
    groupFragment("cin_route_fragment", "cin_route_canonical");

    const summary = await getConnectorSummaryForRoute("cin_route_fragment");
    assert.ok(summary, "expected a resolved summary for the fragment's route");
    assert.equal(
      (summary as { connection_id?: string }).connection_id,
      "cin_route_canonical",
      "a fragment's own route must resolve to its canonical sibling's connection, not its own"
    );
  } finally {
    closeDb();
  }
});

test("an ungrouped connector instance's route resolves to itself, unaffected by an unrelated grouping", async () => {
  initDb();
  try {
    seedManifestConnector("amazon_route_canon_xsurface2");
    seedManifestConnector("github_route_unresolved_xsurface");
    seedInstance("cin_route_canonical2", "amazon_route_canon_xsurface2", "Amazon");
    seedInstance("cin_route_fragment2", "amazon_route_canon_xsurface2", "Amazon (fragment)");
    seedInstance("cin_github_unresolved_route", "github_route_unresolved_xsurface", "GitHub");
    groupFragment("cin_route_fragment2", "cin_route_canonical2");

    const summary = await getConnectorSummaryForRoute("cin_github_unresolved_route");
    assert.ok(summary, "expected a resolved summary for the ungrouped instance's route");
    assert.equal(
      (summary as { connection_id?: string }).connection_id,
      "cin_github_unresolved_route",
      "an ungrouped instance's own route must resolve to itself"
    );
  } finally {
    closeDb();
  }
});
