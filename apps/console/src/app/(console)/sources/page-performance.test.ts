// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Performance / correctness invariants for the reskinned Sources page.
 *
 * The Ink Carbon "loading dock" reskin replaced the prior records-index
 * (`RecordsListView` + streamed version-churn diagnostics + raced
 * device-exporter backlog) with a master-detail Recordroom view. The page now
 * does ONE load-bearing read — a single bounded `loadConnectorSummaryPage`
 * (`listConnectorSummaries({ cursor, limit: 100 })`), NEVER the exhaustive
 * `listAllConnectorSummaries` fold — and projects it with the pure
 * `toSourcesView` mapping. A fleet larger than one page is reached via the
 * shared `ConnectorSummaryPager`, not by prefetching every page server-side.
 * These structural assertions pin that the page stays a single-bounded-page
 * projection, does not reintroduce a blocking diagnostics waterfall, and
 * preserves the reference-unreachable partial fallback (never a thrown blank).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const LOADS_ONE_BOUNDED_PAGE = /loadConnectorSummaryPage\(/;
const NEVER_EXHAUSTS_ALL_PAGES = /listAllConnectorSummaries\(\)/;
const RENDERS_PAGER = /<ConnectorSummaryPager\b/;
const RENDERS_PAGE_ERROR = /<ConnectorSummaryPageError\b/;
const PROJECTS_WITH_VIEW_MODEL = /toSourcesView\(/;
const RENDERS_SHELL = /<RecordroomShellWithPalette\b/;
const RENDERS_SOURCES_VIEW = /<SourcesView\b/;
// The reskin intentionally dropped the streamed version-churn diagnostics and
// the device-exporter backlog read; those belonged to the old index, not the
// loading dock. Pin their absence so a future edit does not silently
// reintroduce a blocking diagnostics waterfall on this surface.
const VERSION_STATS = /listRecordVersionStats\(/;
const DEVICE_EXPORTERS = /listDeviceExporterSourceInstances\(/;
const CHURN_SUSPENSE_SLOT = /versionChurnSlot=/;
const UNREACHABLE_ERROR = /ReferenceServerUnreachableError/;
const UNREACHABLE_FALLBACK = /<ServerUnreachable \/>/;

test("the Sources page does one bounded-page read and projects it with the view model", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // loadConnectorSummaryPage is called from a small file-level helper (so its
  // return type is concretely inferable), not inlined in the page body — so
  // this checks the whole file, not just the page-function slice.
  assert.match(src, LOADS_ONE_BOUNDED_PAGE);
  const pageBody = src.slice(src.indexOf("export default async function RecordsIndexPage"));
  assert.match(pageBody, PROJECTS_WITH_VIEW_MODEL);
  assert.match(pageBody, RENDERS_SHELL);
  assert.match(pageBody, RENDERS_SOURCES_VIEW);
  assert.match(pageBody, RENDERS_PAGER);
  assert.match(pageBody, RENDERS_PAGE_ERROR);
});

test("the Sources page never awaits the exhaustive all-pages fold before first paint", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    NEVER_EXHAUSTS_ALL_PAGES,
    "first render must await exactly one bounded page, never the exhaustive fold"
  );
});

test("the Sources page does not reintroduce a blocking diagnostics waterfall", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, VERSION_STATS, "the loading dock must not block on version-churn stats");
  assert.doesNotMatch(src, DEVICE_EXPORTERS, "the loading dock must not block on device-exporter backlog");
  assert.doesNotMatch(src, CHURN_SUSPENSE_SLOT, "the streamed churn slot belonged to the old index");
});

test("the Sources page preserves the reference-unreachable partial fallback", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // A transient read failure must surface the ServerUnreachable banner inside
  // the shell, not throw to a full-viewport route-error blank.
  assert.match(src, UNREACHABLE_ERROR);
  assert.match(src, UNREACHABLE_FALLBACK);
});
