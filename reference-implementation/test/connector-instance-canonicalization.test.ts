// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `connector-instance-canonicalization.ts` is the single choke point that
 * maps a (possibly grouped) connector_instance_id to its canonical id. These
 * tests pin the resolver's contract against the exact shapes proven in the
 * live production audit this module was built from:
 *   - Amazon: full-containment subset fragments, safe to seed as grouped.
 *   - ChatGPT/Gmail: partial key overlap -- overlap alone must never be
 *     treated as grouped; only an explicit `connector_instance_groups` row
 *     does that.
 *   - GitHub: a different provider user id -- must never resolve to the
 *     canonical id even though the row exists in the same connector.
 *   - Idempotency and rollback of the underlying group table.
 *   - Pagination: `loadOwnerConnectorInstanceGroupsSqlite` must return every
 *     grouped fragment for an owner in one bounded preload, so a caller never
 *     issues a per-row query and grouped fragments can't be dropped mid-page.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exec } from "../lib/db.ts";
import {
  isCanonicalizedFragment,
  loadOwnerConnectorInstanceGroupsSqlite,
  resolveCanonicalConnectorInstanceId,
} from "../server/connector-instance-canonicalization.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { referenceQueries } from "../server/queries/index.ts";

const NOW = "2026-08-15T12:00:00.000Z";

function seedConnector(connectorId: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function seedInstance(ownerSubjectId: string, connectorId: string, connectorInstanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'paused', 'account', ?, '{}', ?, ?)`
    )
    .run(connectorInstanceId, ownerSubjectId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

function group(
  connectorInstanceId: string,
  canonicalConnectorInstanceId: string,
  ownerSubjectId: string,
  reason: string,
  evidence: Record<string, unknown> = {}
): void {
  exec(referenceQueries.connectorInstanceGroupsUpsert, [
    connectorInstanceId,
    canonicalConnectorInstanceId,
    ownerSubjectId,
    reason,
    JSON.stringify(evidence),
    "test-actor",
    NOW,
  ]);
}

test("Amazon-shape subset fragments resolve to their canonical id; the canonical row resolves to itself", () => {
  initDb();
  try {
    seedConnector("amazon");
    seedInstance("owner_1", "amazon", "cin_canonical_amazon");
    seedInstance("owner_1", "amazon", "cin_fragment_amazon_1");
    seedInstance("owner_1", "amazon", "cin_fragment_amazon_2");
    group("cin_fragment_amazon_1", "cin_canonical_amazon", "owner_1", "proven_subset", { overlapKeys: 1145 });
    group("cin_fragment_amazon_2", "cin_canonical_amazon", "owner_1", "proven_subset", { overlapKeys: 2868 });

    const groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_fragment_amazon_1", groups), "cin_canonical_amazon");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_fragment_amazon_2", groups), "cin_canonical_amazon");
    assert.equal(
      resolveCanonicalConnectorInstanceId("cin_canonical_amazon", groups),
      "cin_canonical_amazon",
      "the canonical row is never itself grouped -- it resolves to itself"
    );
    assert.equal(isCanonicalizedFragment("cin_fragment_amazon_1", groups), true);
    assert.equal(isCanonicalizedFragment("cin_canonical_amazon", groups), false);
  } finally {
    closeDb();
  }
});

test("ChatGPT/Gmail-shape partial overlap is NOT grouped without an explicit row: the resolver is an identity function absent one", () => {
  initDb();
  try {
    seedConnector("chatgpt");
    seedInstance("owner_1", "chatgpt", "cin_chatgpt_a");
    seedInstance("owner_1", "chatgpt", "cin_chatgpt_b");
    // Deliberately NOT grouping — overlap evidence alone (19% key overlap in
    // the live audit) is not proof of identity. No connector_instance_groups
    // row is written.
    const groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_chatgpt_a", groups), "cin_chatgpt_a");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_chatgpt_b", groups), "cin_chatgpt_b");
    assert.equal(isCanonicalizedFragment("cin_chatgpt_a", groups), false);
    assert.equal(isCanonicalizedFragment("cin_chatgpt_b", groups), false);
  } finally {
    closeDb();
  }
});

test("GitHub-shape unresolved-identity fragment never resolves to the canonical id, even though both rows share a connector", () => {
  initDb();
  try {
    seedConnector("github");
    seedInstance("owner_1", "github", "cin_github_canonical");
    seedInstance("owner_1", "github", "cin_github_different_user");
    // No group row written for the different-provider-user-id fragment — the
    // live audit's explicit "do not group" decision.
    const groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_github_different_user", groups), "cin_github_different_user");
    assert.notEqual(resolveCanonicalConnectorInstanceId("cin_github_different_user", groups), "cin_github_canonical");
  } finally {
    closeDb();
  }
});

test("grouping the same pair twice is idempotent: one row, unchanged canonical id, no error", () => {
  initDb();
  try {
    seedConnector("amazon");
    seedInstance("owner_1", "amazon", "cin_canonical");
    seedInstance("owner_1", "amazon", "cin_fragment");
    group("cin_fragment", "cin_canonical", "owner_1", "proven_subset", { pass: 1 });
    group("cin_fragment", "cin_canonical", "owner_1", "proven_subset", { pass: 1 });

    const row = getDb()
      .prepare("SELECT COUNT(*) AS count FROM connector_instance_groups WHERE connector_instance_id = ?")
      .get("cin_fragment") as { count: number };
    assert.equal(row.count, 1, "re-grouping the same pair must not create a duplicate row");

    const groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_fragment", groups), "cin_canonical");
  } finally {
    closeDb();
  }
});

test("rollback: deleting the group row fully reverses the grouping", () => {
  initDb();
  try {
    seedConnector("amazon");
    seedInstance("owner_1", "amazon", "cin_canonical");
    seedInstance("owner_1", "amazon", "cin_fragment");
    group("cin_fragment", "cin_canonical", "owner_1", "proven_subset");

    let groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(resolveCanonicalConnectorInstanceId("cin_fragment", groups), "cin_canonical");

    exec(referenceQueries.connectorInstanceGroupsDeleteByFragment, ["cin_fragment"]);

    groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(
      resolveCanonicalConnectorInstanceId("cin_fragment", groups),
      "cin_fragment",
      "after rollback the fragment resolves to itself again, exactly as if it were never grouped"
    );
    assert.equal(isCanonicalizedFragment("cin_fragment", groups), false);
  } finally {
    closeDb();
  }
});

test("pagination: loadOwnerConnectorInstanceGroupsSqlite returns every grouped fragment for an owner in one bounded preload", () => {
  initDb();
  try {
    seedConnector("amazon");
    seedInstance("owner_1", "amazon", "cin_canonical");
    const fragmentIds = Array.from({ length: 12 }, (_, i) => `cin_fragment_${i}`);
    for (const fragmentId of fragmentIds) {
      seedInstance("owner_1", "amazon", fragmentId);
      group(fragmentId, "cin_canonical", "owner_1", "proven_subset");
    }

    const groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(groups.size, fragmentIds.length, "every grouped fragment must be present in a single preload");
    for (const fragmentId of fragmentIds) {
      assert.equal(resolveCanonicalConnectorInstanceId(fragmentId, groups), "cin_canonical");
    }

    // A different owner's groups must never leak into this owner's map.
    seedInstance("owner_2", "amazon", "cin_owner_2_canonical");
    seedInstance("owner_2", "amazon", "cin_owner_2_fragment");
    group("cin_owner_2_fragment", "cin_owner_2_canonical", "owner_2", "proven_subset");

    const owner1Groups = loadOwnerConnectorInstanceGroupsSqlite("owner_1");
    assert.equal(owner1Groups.has("cin_owner_2_fragment"), false);
  } finally {
    closeDb();
  }
});
