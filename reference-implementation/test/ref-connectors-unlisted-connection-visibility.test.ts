// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for the live owner report (2026-08-08): `/sources/add` showed two
 * connections holding records while `/sources` showed neither.
 *
 * Root cause: `projectConnectorSummaryForInstance` dropped any connection whose
 * manifest declares `capabilities.public_listing.tier: "development"`, and the nulls
 * were filtered out inside `projectConnectorSummaryIdentityPage`. `/sources/add`
 * uses the `retained_count_summary` profile, a different projection that never
 * consults the flag — which is why the same data appeared there.
 *
 * Catalog visibility answers "should this connector be OFFERED in the Add Source
 * catalog?". It must NOT suppress connections the owner has ALREADY connected
 * and that hold real records: those are the owner's own data.
 *
 * Two independent defects are pinned here:
 *
 * 1. VISIBILITY — an unlisted connector's configured connection must appear in
 *    the owner's configured-connection list (and on its own detail route).
 *
 * 2. PAGE INTEGRITY — the exclusion ran AFTER the SQL LIMIT with no backfill, so
 *    a page silently shrank (ask for N, get fewer) while still reporting its
 *    pre-filter `has_more`. A post-LIMIT filter that shrinks a page while
 *    claiming completeness is a correctness bug independent of the rule above.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// `listConnectorSummaryPage` encrypts its keyset cursor; the paging test below
// asks for a bounded page and therefore mints one.
process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "test unlisted-connection-visibility cursor key";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  getConnectorSummaryForRoute,
  listConnectorSummaries,
  listConnectorSummaryPage,
} from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const LISTED_CONNECTOR_ID = "https://test.pdpp.dev/connectors/listed-source";
const UNLISTED_CONNECTOR_ID = "https://test.pdpp.dev/connectors/unlisted-source";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-20T12:00:00.000Z";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-unlisted-connection-visibility-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnector(connectorId: string, ownerVisible: boolean): void {
  const manifest = {
    capabilities: {
      public_listing: { tier: ownerVisible ? "supported" : "development" },
    },
    connector_id: connectorId,
    display_name: ownerVisible ? "Listed Source" : "Unlisted Source",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"] }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

async function seedConnection(connectorId: string, connectorInstanceId: string): Promise<void> {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Owner Connection",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_id: connectorInstanceId, kind: "account" },
    // Distinct per connection: the store keys account bindings by
    // (connector_id, source_binding_key), so a shared key collapses every
    // seeded connection onto one row.
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test(
  "an unlisted connector's configured connection stays visible in the owner's connection list",
  withTmpDb(async () => {
    seedConnector(LISTED_CONNECTOR_ID, true);
    seedConnector(UNLISTED_CONNECTOR_ID, false);
    await seedConnection(LISTED_CONNECTOR_ID, "cin_listed_one");
    await seedConnection(UNLISTED_CONNECTOR_ID, "cin_unlisted_one");

    const summaries = await listConnectorSummaries();
    const connectorIds = summaries.map((row) => row.connector_id);

    assert.ok(
      connectorIds.includes(UNLISTED_CONNECTOR_ID),
      "a connection the owner already configured must not be hidden by the Add Source catalog flag"
    );
    assert.ok(connectorIds.includes(LISTED_CONNECTOR_ID), "listed connectors are unaffected");
  })
);

test(
  "an unlisted connector's connection resolves on its own route",
  withTmpDb(async () => {
    seedConnector(UNLISTED_CONNECTOR_ID, false);
    await seedConnection(UNLISTED_CONNECTOR_ID, "cin_unlisted_route");

    const summary = await getConnectorSummaryForRoute("cin_unlisted_route");

    assert.ok(summary, "the owner's own connection must resolve by its connection id");
    assert.equal(summary.connector_id, UNLISTED_CONNECTOR_ID);
  })
);

test(
  "a page whose rows include unlisted connectors returns a full page, not a silently shrunk one",
  withTmpDb(async () => {
    // Interleave so the unlisted rows fall INSIDE the first page's LIMIT window:
    // connector_id is the primary sort key, and the unlisted id sorts last, so
    // seed enough of each that a limit-sized page spans both.
    seedConnector(LISTED_CONNECTOR_ID, true);
    seedConnector(UNLISTED_CONNECTOR_ID, false);
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture seeding.
      await seedConnection(LISTED_CONNECTOR_ID, `cin_listed_${i}`);
    }
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture seeding.
      await seedConnection(UNLISTED_CONNECTOR_ID, `cin_unlisted_${i}`);
    }

    const limit = 4;
    const page = await listConnectorSummaryPage(null, { limit, ownerSubjectId: OWNER_SUBJECT_ID });

    // The SQL LIMIT counted 4 rows; all 4 must actually be returned. Before the
    // fix the 3 unlisted rows were dropped after the LIMIT, so a limit-4 request
    // returned 1 row while `has_more` still described the pre-filter cursor.
    assert.equal(page.data.length, limit, "every row the LIMIT counted must be returned");
    assert.equal(page.has_more, true, "6 seeded connections cannot fit in one limit-4 page");

    // And a full traversal must reach all 6 rather than permanently losing the
    // filtered ones.
    const all = await listConnectorSummaries();
    assert.equal(all.length, 6, "a full traversal returns every configured connection");
  })
);
