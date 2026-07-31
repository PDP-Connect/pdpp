// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural tests for `existing-sources-by-connector.ts` — closes gate
 * finding R5 (design doc add-source-perf-design-agy-0730.md; Fable ruling
 * terminal-read-architecture-fable-0730.md §2 R5): Add Source / manual
 * upload / grant connection pins must consume the batched
 * `retained_count_summary` profile via a bounded repeated `connector_id`
 * scope, never the 33-call catalog inventory + per-live-connection scoped
 * full-summary N+1 this module previously issued, and never an unbounded
 * fleet page.
 *
 * `ref-client.ts` imports `server-only` transitively (via `owner-token.ts`),
 * so this module cannot execute in a plain `node:test` process — same
 * limitation `ref-client-pagination.test.ts` documents. These tests pin the
 * source-level contract instead:
 *   - the seam is the batched `retained_count_summary` profile
 *     (`listConnectorSummaries({ connectorId: [...], profile:
 *     "retained_count_summary" })`), never `listConnectionsByConnector` or a
 *     per-connection scoped `connectionRouteId` backfill;
 *   - the catalog path partitions into bounded (≤100-id) scopes and traverses
 *     each to exhaustion via `next_cursor`/`has_more`, never one request per
 *     catalog connector id;
 *   - cross-partition fan-out is bounded via `mapWithConcurrency`, never an
 *     unbounded `Promise.all` across every partition (gate finding closed:
 *     `add-source-batched-profile-gate-0730.md`, "Partition concurrency is
 *     unbounded across partitions") — `concurrency.test.ts` proves the
 *     primitive itself holds its bound at >10,000 items;
 *   - revoked connections (both `status === "revoked"` and a set
 *     `revoked_at`) are filtered out;
 *   - there is no `complete`/incompleteness field anywhere in this module —
 *     the result is exact by construction (exhausted traversal over an exact
 *     connector-id scope), so there is nothing partial left to disclose.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MODULE_FILE = `${HERE}existing-sources-by-connector.ts`;

const USES_RETAINED_COUNT_PROFILE_RE = /profile:\s*"retained_count_summary"/;
const USES_CONNECTOR_ID_SET_SCOPE_RE = /connectorId:\s*connectorIds/;
const NO_LEGACY_CONNECTIONS_SEAM_RE = /\blistConnectionsByConnector\b/;
const NO_SCOPED_PER_CONNECTION_BACKFILL_RE = /connectionRouteId:\s*connection\.connector_instance_id/;
const NO_BOUNDED_FLEET_PAGE_RE = /\bloadConnectorSummaryPage\b/;
const NO_LIST_ALL_CONNECTOR_SUMMARIES_RE = /\blistAllConnectorSummaries\b/;
const FOLLOWS_CURSOR_TO_EXHAUSTION_RE = /page\.has_more\s*&&\s*page\.next_cursor/;
const PARTITIONS_BOUNDED_RE = /CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX/;
const NO_COMPLETE_FIELD_RE = /\bcomplete\s*[:?]/;
const FILTERS_REVOKED_STATUS_RE = /row\.status\s*!==\s*"revoked"/;
const FILTERS_REVOKED_AT_RE = /!row\.revoked_at/;
const NO_PER_CATALOG_ID_FAN_OUT_RE = /connectorIds\.map\(\s*async \(connectorId\)/;
const USES_BOUNDED_CONCURRENCY_RE = /mapWithConcurrency\(\s*partitions,\s*EXISTING_SOURCES_PARTITION_CONCURRENCY/;
const NO_UNBOUNDED_PROMISE_ALL_ACROSS_PARTITIONS_RE = /Promise\.all\(\s*partitions\.map/;

test("the batched retained_count_summary profile is the seam, never the legacy per-connector connections list or a per-connection scoped backfill", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, USES_RETAINED_COUNT_PROFILE_RE);
  assert.match(src, USES_CONNECTOR_ID_SET_SCOPE_RE);
  assert.doesNotMatch(
    src,
    NO_LEGACY_CONNECTIONS_SEAM_RE,
    "existing-sources discovery must not call the exact per-connector connections list anymore"
  );
  assert.doesNotMatch(
    src,
    NO_SCOPED_PER_CONNECTION_BACKFILL_RE,
    "the batched profile already carries total_records/acquisition_coverage — no per-connection backfill call remains"
  );
  assert.doesNotMatch(
    src,
    NO_BOUNDED_FLEET_PAGE_RE,
    "existing-sources discovery must never fall back to a fleet-wide bounded page"
  );
  assert.doesNotMatch(src, NO_LIST_ALL_CONNECTOR_SUMMARIES_RE, "the exhaustive fold must never return here");
});

test("connector-id scopes are traversed to exhaustion via next_cursor/has_more, and partitioned at the accepted set-scope ceiling", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, FOLLOWS_CURSOR_TO_EXHAUSTION_RE);
  assert.match(src, PARTITIONS_BOUNDED_RE);
});

test("revoked connections are filtered by BOTH status and revoked_at", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(src, FILTERS_REVOKED_STATUS_RE);
  assert.match(src, FILTERS_REVOKED_AT_RE);
});

test("there is no complete/incompleteness escape hatch anywhere in this module — exhausted traversal is exact by construction", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.doesNotMatch(src, NO_COMPLETE_FIELD_RE);
});

test("existingSourcesByConnectorCatalog issues one batched partitioned traversal, never one request per catalog connector id", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    NO_PER_CATALOG_ID_FAN_OUT_RE,
    "the catalog path must not fan out one request per connector id anymore"
  );
});

test("cross-partition fan-out is bounded via mapWithConcurrency, never an unbounded Promise.all across every partition", async () => {
  const src = await readFile(MODULE_FILE, "utf8");
  assert.match(
    src,
    USES_BOUNDED_CONCURRENCY_RE,
    "fetchRetainedCountSummaries must route partitions through mapWithConcurrency at the fixed concurrency bound"
  );
  assert.doesNotMatch(
    src,
    NO_UNBOUNDED_PROMISE_ALL_ACROSS_PARTITIONS_RE,
    "an unbounded Promise.all across partitions would issue one concurrent request per partition for an arbitrarily large catalog"
  );
});
