// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("page.tsx", import.meta.url));
const VIEW_FILE = fileURLToPath(new URL("syncs-view.tsx", import.meta.url));

const REDIRECT_IMPORT_RE = /import\s+\{\s*redirect\s*\}\s+from\s+["']next\/navigation["']/;
const PEEK_REDIRECT_RE =
  /if\s*\(\s*params\.peek\s*\)\s*\{[\s\S]*redirect\(dashboardRoutes\.run\(params\.peek\)\);[\s\S]*\}/;
// The Syncs reskin fetches the runs feed inside a `Promise.all`, so the
// invariant is "the first `listRuns(` call appears after the peek redirect",
// not the old `result = await listRuns(` assignment shape.
const LIST_RUNS_RE = /\blistRuns\(/;
const RUN_TIMELINE_FETCH_RE = /\bgetRunTimeline\(/;
const SYNCS_OVERVIEW_RUN_LIMIT_RE = /const\s+SYNCS_OVERVIEW_RUN_LIMIT\s*=\s*(\d+);/;
const CONNECTOR_PREFETCH_FALSE_RE = /href=\{dashboardRoutes\.connector\(card\.connectionId\)\}\s+prefetch=\{false\}/;
const RUNS_FILTER_PREFETCH_FALSE_RE =
  /href=\{`\$\{dashboardRoutes\.section\.runs\}\?connector_id=\$\{encodeURIComponent\(card\.connectorId\)\}`\}\s+prefetch=\{false\}/;
const BROWSE_PREFETCH_FALSE_RE = /href=\{row\.browseHref\}\s+prefetch=\{false\}/;
const ACTIVE_SYNC_LINK_RE = /Active sync →/;
const ACTIVE_SYNC_PREFETCH_FALSE_RE = /href=\{activeRunHref\}\s+prefetch=\{false\}/;
const USE_CLIENT_RE = /^["']use client["'];?/m;
const NATIVE_DISCLOSURE_RE = /<details className="rr-sync-row-shell">/;
const USE_STATE_RE = /useState\(/;
const REVIEW_LABEL_RE = /reviewLabel = "need review"/;
const REVIEW_CARDS_COPY_RE = /Review the cards below\./;
const OLD_ALL_CLEAR_COPY_RE = /band\.allClear \? `Nothing needs you right now\. \$\{RESET_NOTE\}` : RESET_NOTE/;
const FAILURE_SECTION_ORDER_RE =
  /const FAILURE_SECTION_ORDER = \["needsOwner", "review", "systemIssue", "working", "notMeasured", "other"\]/;
const FAILURE_CARD_SECTION_RE = /function AttentionSection\(/;
const FAILURE_CARD_SECTIONS_CALL_RE = /attentionSections\(model\)/;
// Draft/pending-setup cards are the same KIND of owner work as a
// verdict-derived needs-you card, so they fold into the ONE `needsOwner`
// section. A second top-level section rendering pending-setup cards under the
// same heading is the duplicate-group defect this guards against.
const PENDING_SETUP_FOLDED_RE = /section === "needsOwner" \? \[\.\.\.model\.pendingSetupCards\] : \[\]/;
const STANDALONE_PENDING_SECTION_RE =
  /model\.pendingSetupCards\.length > 0 \? \(\s*<section className="rr-sync__fix-section"/;
const FAILURE_CARD_SOURCE_WORK_RE = /card\.work\?\.group \?\? "other"[\s\S]{0,80}data-source-work=/;
// The runs fetch is now a real cursor page (`run_cursor`/`status`/`connector_id`),
// so the invariant is "the bounded per-page limit constant is used", not the old
// literal `listRuns({ limit: SYNCS_OVERVIEW_RUN_LIMIT })` call shape.
const SYNCS_OVERVIEW_LIST_RUNS_RE = /limit:\s*SYNCS_OVERVIEW_RUN_LIMIT/;
const RECENT_LIST_RENDER_RE = /<RecentSyncsSection entries=\{model\.recentSyncs\} paging=\{recentSyncsPaging\} \/>/;
const RECENT_ROW_HREF_RE = /href=\{entry\.href\}/;
const RECENT_ROW_PREFETCH_FALSE_RE = /href=\{entry\.href\}\s+prefetch=\{false\}/;

test("run list peek query opens the full run detail route instead of inline details", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, REDIRECT_IMPORT_RE, "runs page must use Next redirect for peek deep links");
  assert.match(src, PEEK_REDIRECT_RE, "runs page must redirect ?peek=<run_id> to the run detail route");
  assert.equal(
    src.indexOf("redirect(dashboardRoutes.run(params.peek));") < src.search(LIST_RUNS_RE),
    true,
    "peek redirect must happen before list fetches"
  );
  assert.doesNotMatch(src, RUN_TIMELINE_FETCH_RE, "run list page must not fetch inline run timeline details");
});

test("syncs dense dynamic links opt out of automatic route prefetch", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(
    src,
    CONNECTOR_PREFETCH_FALSE_RE,
    "owner-action source links must not prefetch dynamic source detail routes"
  );
  assert.match(
    src,
    RUNS_FILTER_PREFETCH_FALSE_RE,
    "failure-card run filter links must not prefetch dynamic runs routes"
  );
  assert.match(src, BROWSE_PREFETCH_FALSE_RE, "stream browse links must not prefetch dynamic explore routes");
  assert.match(src, ACTIVE_SYNC_LINK_RE, "active sync affordance must use exact sync wording");
  assert.match(src, ACTIVE_SYNC_PREFETCH_FALSE_RE, "active sync link must not prefetch dynamic run routes");
});

test("syncs view stays server-rendered by default", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.doesNotMatch(src, USE_CLIENT_RE, "runs must not hydrate the entire syncs view");
  assert.match(src, NATIVE_DISCLOSURE_RE, "row details should use native disclosure");
  assert.doesNotMatch(src, USE_STATE_RE, "page-wide row disclosure state would force full-page client hydration");
});

test("syncs health band distinguishes advisory review from all-clear", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, REVIEW_LABEL_RE);
  assert.match(src, REVIEW_CARDS_COPY_RE);
  assert.doesNotMatch(src, OLD_ALL_CLEAR_COPY_RE, "visible failure cards must not render the all-clear copy");
});

test("syncs failure cards render through source-work sections", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, FAILURE_SECTION_ORDER_RE);
  assert.match(src, FAILURE_CARD_SECTION_RE);
  assert.match(src, FAILURE_CARD_SECTIONS_CALL_RE);
  assert.match(src, FAILURE_CARD_SOURCE_WORK_RE);
});

test("pending-setup cards fold into the one needs-you section, never a second one", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, PENDING_SETUP_FOLDED_RE, "draft connections must join the needsOwner section");
  assert.doesNotMatch(
    src,
    STANDALONE_PENDING_SECTION_RE,
    "a standalone pending-setup section duplicates the needs-you heading"
  );
});

test("recent syncs list drills into the run detail route", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, RECENT_LIST_RENDER_RE, "syncs must render the recent-runs list");
  assert.match(src, RECENT_ROW_HREF_RE, "each recent sync row must link to its run detail route");
  assert.match(src, RECENT_ROW_PREFETCH_FALSE_RE, "recent sync rows must not prefetch dynamic run routes");
});

test("syncs first-paint run feed is bounded to the overview budget", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const limitMatch = src.match(SYNCS_OVERVIEW_RUN_LIMIT_RE);

  assert.ok(limitMatch, "runs page must name its first-paint run feed limit");
  assert.ok(Number(limitMatch[1]) <= 25, "syncs overview must not hydrate a deep run history before first paint");
  assert.match(src, SYNCS_OVERVIEW_LIST_RUNS_RE, "syncs overview must use the bounded first-paint run feed limit");
});

const RUN_CURSOR_QUERY_RE = /cursor:\s*params\.run_cursor \|\| undefined/;
const RUN_STATUS_QUERY_RE = /status:\s*params\.status \|\| undefined/;
const NO_UNBOUNDED_LIST_RUNS_RE = /\blistRuns\(\s*\)/;
const RECENT_FILTER_FORM_RE = /<form\s+action=\{RECENT_SYNCS_PATH\}[\s\S]{0,120}method="get"/;
const RECENT_FILTER_STATUS_SELECT_RE = /name="status"[\s\S]{0,80}options=\{paging\.statusOptions\}/;
const RECENT_PAGER_NEXT_HREF_RE = /run_cursor:\s*paging\.nextCursor/;

test("recent syncs run feed pages by cursor and filters by a real server-side status, never an unbounded fetch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, RUN_CURSOR_QUERY_RE, "the runs query must forward the run_cursor search param to listRuns");
  assert.match(src, RUN_STATUS_QUERY_RE, "the status filter must forward params.status verbatim to listRuns");
  assert.doesNotMatch(src, NO_UNBOUNDED_LIST_RUNS_RE, "listRuns must never be called with no bound at all");
});

test("recent syncs filter form is a plain GET form with no client hydration on the view", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, RECENT_FILTER_FORM_RE, "the status filter must be a server-rendered GET form");
  assert.match(
    src,
    RECENT_FILTER_STATUS_SELECT_RE,
    "the status select must only offer the real server-supplied options"
  );
  assert.doesNotMatch(src, USE_CLIENT_RE, "adding the filter form must not turn the view into a client component");
  assert.doesNotMatch(src, USE_STATE_RE, "the filter form must submit via native GET, not client state");
});

const RECENT_FILTER_CONNECTOR_SELECT_RE = /name="connector_id"[\s\S]{0,80}options=\{paging\.connectorOptions\}/;
const RECENT_FILTER_CONNECTOR_HIDDEN_INPUT_RE = /<input\s+name="connector_id"\s+type="hidden"/;
const CONNECTOR_QUERY_RE = /connector_id:\s*params\.connector_id \|\| undefined/;
const CONNECTOR_OPTIONS_FROM_FLEET_PAGE_RE =
  /connectorOptions:\s*connectorFilterOptions\(connectorsPage\.items,\s*params\.connector_id\)/;
const CONNECTOR_OPTIONS_ANY_SOURCE_RE = /\{ label: "any source", value: "" \}/;
// The picker must be built from identity fields the reference already returned.
// Any literal connector key here would mean the console had grown its own
// roster, which is exactly what this filter must never do.
const CONNECTOR_OPTIONS_PROJECTION_RE = /connector\.connector_display_name \|\| connector\.connector_id/;
const SORT_PARAM_RE = /\bsort\s*[:=]|name="sort"|localeCompare\(.*outcome/;

test("recent syncs offers a real connector picker, not a hidden input the owner cannot reach", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(
    src,
    RECENT_FILTER_CONNECTOR_SELECT_RE,
    "the source filter must be a real select bound to the server-supplied connector options"
  );
  assert.doesNotMatch(
    src,
    RECENT_FILTER_CONNECTOR_HIDDEN_INPUT_RE,
    "connector_id must no longer survive only as a hidden input — the owner must be able to choose it"
  );
});

test("connector filter options come from the fleet page the route already fetched, never a hardcoded roster", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, CONNECTOR_QUERY_RE, "the connector filter must forward params.connector_id verbatim to listRuns");
  assert.match(
    src,
    CONNECTOR_OPTIONS_FROM_FLEET_PAGE_RE,
    "connector options must be projected from the connector-summary page, not fetched or invented separately"
  );
  assert.match(src, CONNECTOR_OPTIONS_ANY_SOURCE_RE, "the picker must offer an explicit option that clears the filter");
  assert.match(
    src,
    CONNECTOR_OPTIONS_PROJECTION_RE,
    "option labels must come from the reference's own identity fields"
  );
});

test("recent syncs still refuses to offer a sort control the runs feed cannot honour", async () => {
  const viewSrc = await readFile(VIEW_FILE, "utf8");
  const pageSrc = await readFile(PAGE_FILE, "utf8");

  // `_ref/runs` has no sort parameter. A client-side sort would reorder only the
  // current page while reading as a whole-feed sort, so neither surface may grow one.
  assert.doesNotMatch(viewSrc, SORT_PARAM_RE, "the syncs view must not offer a sort the runs feed cannot apply");
  assert.doesNotMatch(pageSrc, SORT_PARAM_RE, "the syncs route must not forward a sort param the feed does not accept");
});

test("recent syncs pager links to the next cursor the server returned, never a fabricated offset", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, RECENT_PAGER_NEXT_HREF_RE, "the older-syncs link must carry the real next_cursor from the server");
});

const COVERAGE_HUMANIZER_IMPORT_RE = /formatCoverageAxis[\s\S]{0,40}from "\.\.\/lib\/connection-evidence\.ts"/;
const COVERAGE_HUMANIZER_CALL_RE = /formatCoverageAxis\(condition\)\.value/;
const RAW_COVERAGE_INTERPOLATION_RE = /`\s*·\s*\$\{condition\}`/;

test("stream coverage never leaks the raw internal axis key (e.g. terminal_gap) — it goes through the shared humanizer", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, COVERAGE_HUMANIZER_IMPORT_RE, "coverage copy must reuse the shared formatCoverageAxis humanizer");
  assert.match(
    src,
    COVERAGE_HUMANIZER_CALL_RE,
    "the coverage suffix must render formatCoverageAxis's owner-facing value"
  );
  assert.doesNotMatch(
    src,
    RAW_COVERAGE_INTERPOLATION_RE,
    "the raw coverage_condition value (e.g. terminal_gap, retryable_gap) must never be interpolated directly into copy"
  );
});
