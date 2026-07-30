// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural tests for `existing-sources-by-connector.ts` — closes gate
 * finding 1 (Add Source / manual upload / grant connection pins must
 * consume the exact `GET /_ref/connections?connector_id=` seam, never the
 * rejected one-arbitrary-fleet-page `complete`/`existingSourcesIncomplete`
 * stopgap this module replaces).
 *
 * `ref-client.ts` imports `server-only` transitively (via `owner-token.ts`),
 * so this module cannot execute in a plain `node:test` process — same
 * limitation `ref-client-pagination.test.ts` documents. These tests pin the
 * source-level contract instead:
 *   - the seam (`listConnectionsByConnector`) is actually called, never a
 *     bounded fleet page (`listConnectorSummaries` with no
 *     `connectionRouteId`);
 *   - every returned connection is backfilled via a SCOPED
 *     `connectionRouteId` lookup (never a second unscoped fleet read);
 *   - revoked connections (both `status: "revoked"` and a set
 *     `revoked_at`) are filtered out;
 *   - there is no `complete`/incompleteness field anywhere in this module —
 *     the result is exact by construction, so there is nothing partial left
 *     to disclose.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MODULE_FILE = `${HERE}existing-sources-by-connector.ts`;

const USES_SEAM_RE = /listConnectionsByConnector\(connectorId\)/;
const NO_BOUNDED_FLEET_PAGE_RE = /\bloadConnectorSummaryPage\b/;
const NO_LIST_ALL_CONNECTOR_SUMMARIES_RE = /\blistAllConnectorSummaries\b/;
const SCOPED_BACKFILL_RE = /listConnectorSummaries\(\{\s*connectionRouteId:\s*connection\.connector_instance_id\s*\}\)/;
const NO_COMPLETE_FIELD_RE = /\bcomplete\s*[:?]/;
const FILTERS_REVOKED_STATUS_RE = /connection\.status\s*!==\s*"revoked"/;
const FILTERS_REVOKED_AT_RE = /!connection\.revoked_at/;
const CATALOG_FAN_OUT_RE = /connectorIds\.map\(\s*async \(connectorId\)/;
const CATALOG_CALLS_SEAM_RE = /await existingSourcesForConnector\(connectorId\)/;

test("existingSourcesForConnector consumes the exact listConnectionsByConnector seam, never a bounded fleet page", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, USES_SEAM_RE);
  assert.doesNotMatch(
    src,
    NO_BOUNDED_FLEET_PAGE_RE,
    "existing-sources discovery must never fall back to a fleet-wide bounded page"
  );
  assert.doesNotMatch(src, NO_LIST_ALL_CONNECTOR_SUMMARIES_RE, "the exhaustive fold must never return here");
});

test("every connection the seam returns is backfilled via a SCOPED connectionRouteId lookup, never an unscoped fleet read", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, SCOPED_BACKFILL_RE);
});

test("revoked connections are filtered by BOTH status and revoked_at", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, FILTERS_REVOKED_STATUS_RE);
  assert.match(src, FILTERS_REVOKED_AT_RE);
});

test("there is no complete/incompleteness escape hatch anywhere in this module — the seam result is exact by construction", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.doesNotMatch(src, NO_COMPLETE_FIELD_RE);
});

test("existingSourcesByConnectorCatalog fans out one seam call per catalog connector id, bounded by catalog size, never fleet size", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, CATALOG_FAN_OUT_RE);
  assert.match(src, CATALOG_CALLS_SEAM_RE);
});
