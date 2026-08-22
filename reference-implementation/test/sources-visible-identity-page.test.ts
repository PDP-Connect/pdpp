// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `listSourcesVisibleIdentityPage` — the Sources-page-only sibling of
 * `listOwnerVisibleIdentityPage` — must exclude a PURE recovered historical
 * fragment (`source_binding.kind === "historical_archive"` with
 * `recovery_reason === "connection_metadata_missing"` and no UAT-transfer
 * marker) BEFORE `LIMIT`, never as a post-LIMIT filter. This is the
 * regression test for the known filter-after-LIMIT defect: if hidden rows
 * were filtered client-side after paging, a page full of hidden fragments
 * would render short (or empty) while reporting `hasMore: true` from a
 * cursor that never advances the caller past those hidden rows in one hop —
 * exactly the failure mode this store method exists to avoid.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exec } from "../lib/db.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { referenceQueries } from "../server/queries/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

function groupFragment(
  connectorInstanceId: string,
  canonicalConnectorInstanceId: string,
  ownerSubjectId: string
): void {
  exec(referenceQueries.connectorInstanceGroupsUpsert, [
    connectorInstanceId,
    canonicalConnectorInstanceId,
    ownerSubjectId,
    "proven_subset",
    "{}",
    "test-actor",
    "2026-08-15T12:00:00.000Z",
  ]);
}

function insertRun(connectorInstanceId: string, connectorId: string, status: string, startedAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at, attempt) VALUES (?, ?, ?, '{}', ?, ?, 1)"
    )
    .run(`run_${connectorInstanceId}_${startedAt}`, connectorInstanceId, connectorId, status, startedAt);
}

function enrollmentShellBinding(): Record<string, unknown> {
  return { kind: "browser_enrollment_shell" };
}

const NOW = "2026-06-10T18:00:00.000Z";

function seedSqliteConnector(connectorId: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function pureFragmentBinding(originalId: string): Record<string, unknown> {
  return {
    kind: "historical_archive",
    original_connector_instance_id: originalId,
    recovery_reason: "connection_metadata_missing",
  };
}

function uatTransferredBinding(originalId: string): Record<string, unknown> {
  // Google Maps / WhatsApp UAT imports: same historical_archive kind, but
  // carries a UAT-transfer marker — must stay visible on Sources.
  return {
    kind: "historical_archive",
    latest_uat_source_instance_id: `uat_${originalId}`,
    original_connector_instance_id: originalId,
    recovery_reason: "connection_metadata_missing",
  };
}

test("listSourcesVisibleIdentityPage RETURNS a pure recovered fragment (rendered as archived), alongside UAT-transferred and active rows", () => {
  initDb();
  try {
    seedSqliteConnector("chase");
    seedSqliteConnector("google_maps");
    seedSqliteConnector("gmail");
    const store = createSqliteConnectorInstanceStore();

    store.upsert({
      connectorId: "chase",
      connectorInstanceId: "cin_pure_fragment",
      createdAt: NOW,
      displayName: "Chase",
      ownerSubjectId: "owner_1",
      sourceBinding: pureFragmentBinding("cin_pure_fragment_original"),
      sourceBindingKey: "historical_archive_cin_pure_fragment",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    store.upsert({
      connectorId: "google_maps",
      connectorInstanceId: "cin_uat_transfer",
      createdAt: NOW,
      displayName: "Google Maps",
      ownerSubjectId: "owner_1",
      sourceBinding: uatTransferredBinding("cin_uat_transfer_original"),
      sourceBindingKey: "historical_archive_cin_uat_transfer",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    store.upsert({
      connectorId: "gmail",
      connectorInstanceId: "cin_active",
      createdAt: NOW,
      displayName: "Gmail",
      ownerSubjectId: "owner_1",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });

    const page = store.listSourcesVisibleIdentityPage("owner_1", { limit: 100 });
    assert.deepEqual(
      page.rows.map((row) => row.connectorInstanceId).sort(),
      ["cin_active", "cin_pure_fragment", "cin_uat_transfer"],
      "the pure fragment is RETURNED — the console classifies it archived and renders it in the Archived group; dropping it here made its records visible on no summary surface"
    );
    assert.equal(page.hasMore, false);

    // Explore's connection-facet listing (`listOwnerVisibleIdentityPage`) must
    // be UNCHANGED: the pure fragment's connection facet stays reachable there.
    const unfilteredPage = store.listOwnerVisibleIdentityPage("owner_1", { limit: 100 });
    assert.deepEqual(
      unfilteredPage.rows.map((row) => row.connectorInstanceId).sort(),
      ["cin_active", "cin_pure_fragment", "cin_uat_transfer"],
      "the shared identity page Explore reads from stays unchanged"
    );
  } finally {
    closeDb();
  }
});

test("listSourcesVisibleIdentityPage keeps hasMore/pagination correct when excluded rows fill the first page and a visible row sits beyond it", () => {
  initDb();
  try {
    seedSqliteConnector("chase");
    seedSqliteConnector("gmail");
    const store = createSqliteConnectorInstanceStore();

    // Three GROUPED fragments under "chase" (sorts before "gmail" by
    // connector_id ASC — the identity page's primary sort key), then one
    // active "gmail" connection. Grouped fragments are the rows this page
    // still excludes: a grouped child never renders its own Sources row, only
    // its canonical sibling does.
    //
    // A post-LIMIT filter applied to a limit:3 page would return zero rows
    // and (depending on implementation) could misreport hasMore or silently
    // short the page. The pre-LIMIT exclusion must instead skip past the
    // grouped rows inside the query and return the one visible row.
    store.upsert({
      connectorId: "chase",
      connectorInstanceId: "cin_canonical",
      createdAt: NOW,
      displayName: "Chase canonical",
      ownerSubjectId: "owner_2",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    for (const i of [0, 1, 2]) {
      store.upsert({
        connectorId: "chase",
        connectorInstanceId: `cin_fragment_${i}`,
        createdAt: NOW,
        displayName: `Chase ${i}`,
        ownerSubjectId: "owner_2",
        sourceBindingKey: `chase_fragment_${i}`,
        sourceKind: "account",
        status: "paused",
        updatedAt: NOW,
      });
      groupFragment(`cin_fragment_${i}`, "cin_canonical", "owner_2");
    }
    store.upsert({
      connectorId: "gmail",
      connectorInstanceId: "cin_visible",
      createdAt: NOW,
      displayName: "Gmail",
      ownerSubjectId: "owner_2",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });

    // LIMIT (3) sized so the excluded rows alone would fill it. A post-LIMIT
    // filter would drop `cin_visible` entirely; the pre-LIMIT exclusion must
    // walk past the grouped rows within the query and still surface it.
    const page = store.listSourcesVisibleIdentityPage("owner_2", { limit: 3 });
    assert.deepEqual(
      page.rows.map((row) => row.connectorInstanceId),
      ["cin_canonical", "cin_visible"],
      "the visible rows beyond the grouped fragments must still surface on a page sized to exactly the excluded count"
    );
    assert.equal(page.hasMore, false, "hasMore must reflect the rendered rows, not the excluded rows consumed");
  } finally {
    closeDb();
  }
});

test("listSourcesVisibleIdentityPage excludes a grouped fragment (account-unification canonicalization), keeping only the canonical row; listOwnerVisibleIdentityPage still returns both and reports canonicalConnectorInstanceId", () => {
  initDb();
  try {
    seedSqliteConnector("amazon");
    seedSqliteConnector("github");
    const store = createSqliteConnectorInstanceStore();

    store.upsert({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_canonical",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_3",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    store.upsert({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_fragment",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_3",
      sourceBindingKey: "amazon_fragment",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    // GitHub-shape unresolved-identity sibling: shares nothing with the
    // grouping above and must remain fully independent on every surface.
    store.upsert({
      connectorId: "github",
      connectorInstanceId: "cin_github_unresolved",
      createdAt: NOW,
      displayName: "GitHub",
      ownerSubjectId: "owner_3",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    groupFragment("cin_amazon_fragment", "cin_amazon_canonical", "owner_3");

    const sourcesPage = store.listSourcesVisibleIdentityPage("owner_3", { limit: 100 });
    assert.deepEqual(
      sourcesPage.rows.map((row) => row.connectorInstanceId).sort(),
      ["cin_amazon_canonical", "cin_github_unresolved"],
      "the grouped fragment never renders its own Sources row; only its canonical sibling does"
    );

    const explorePage = store.listOwnerVisibleIdentityPage("owner_3", { limit: 100 });
    assert.deepEqual(
      explorePage.rows.map((row) => row.connectorInstanceId).sort(),
      ["cin_amazon_canonical", "cin_amazon_fragment", "cin_github_unresolved"],
      "Explore's facet listing keeps returning every row, fragments included"
    );
    const fragmentRow = explorePage.rows.find((row) => row.connectorInstanceId === "cin_amazon_fragment");
    const canonicalRow = explorePage.rows.find((row) => row.connectorInstanceId === "cin_amazon_canonical");
    const githubRow = explorePage.rows.find((row) => row.connectorInstanceId === "cin_github_unresolved");
    assert.equal(fragmentRow?.canonicalConnectorInstanceId, "cin_amazon_canonical");
    assert.equal(canonicalRow?.canonicalConnectorInstanceId, "cin_amazon_canonical");
    assert.equal(
      githubRow?.canonicalConnectorInstanceId,
      "cin_github_unresolved",
      "an ungrouped row's canonical id is itself (identity function)"
    );
  } finally {
    closeDb();
  }
});

test("listSourcesVisibleIdentityPage returns a revoked browser-enrollment shell that never had a successful run — repeated failed setup is the owner's only record of the attempt", () => {
  initDb();
  try {
    seedSqliteConnector("venmo");
    const store = createSqliteConnectorInstanceStore();

    store.upsert({
      connectorId: "venmo",
      connectorInstanceId: "cin_venmo_shell",
      createdAt: NOW,
      displayName: "Venmo",
      ownerSubjectId: "owner_4",
      revokedAt: NOW,
      sourceBinding: enrollmentShellBinding(),
      sourceBindingKey: "browser_shell_venmo",
      sourceKind: "browser_collector",
      status: "revoked",
      updatedAt: NOW,
    });
    insertRun("cin_venmo_shell", "venmo", "failed", "2026-06-10T17:00:00.000Z");
    insertRun("cin_venmo_shell", "venmo", "abandoned", "2026-06-10T17:30:00.000Z");

    const page = store.listSourcesVisibleIdentityPage("owner_4", { limit: 100 });
    assert.deepEqual(
      page.rows.map((row) => row.connectorInstanceId),
      ["cin_venmo_shell"],
      "a never-succeeded revoked setup shell must surface on Sources — no other row represents the attempt"
    );

    const explorePage = store.listOwnerVisibleIdentityPage("owner_4", { limit: 100 });
    assert.deepEqual(
      explorePage.rows,
      [],
      "the shared owner-visible predicate is UNCHANGED — the never-succeeded escape is Sources-only, not a general policy change"
    );
  } finally {
    closeDb();
  }
});

test("listSourcesVisibleIdentityPage still excludes a revoked browser-enrollment shell that DID succeed — its promoted row is the connection to show, not the spent shell", () => {
  initDb();
  try {
    seedSqliteConnector("amazon");
    const store = createSqliteConnectorInstanceStore();

    store.upsert({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_shell",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_5",
      revokedAt: NOW,
      sourceBinding: enrollmentShellBinding(),
      sourceBindingKey: "browser_shell_amazon",
      sourceKind: "browser_collector",
      status: "revoked",
      updatedAt: NOW,
    });
    store.upsert({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_promoted",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_5",
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    insertRun("cin_amazon_shell", "amazon", "failed", "2026-06-10T17:00:00.000Z");
    insertRun("cin_amazon_shell", "amazon", "succeeded", "2026-06-10T17:30:00.000Z");

    const page = store.listSourcesVisibleIdentityPage("owner_5", { limit: 100 });
    assert.deepEqual(
      page.rows.map((row) => row.connectorInstanceId),
      ["cin_amazon_promoted"],
      "a shell with a successful run stays excluded — the promoted row already represents this connection"
    );
  } finally {
    closeDb();
  }
});
