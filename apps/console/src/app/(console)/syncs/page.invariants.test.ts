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
const USE_CLIENT_RE = /^["']use client["'];?/m;
const NATIVE_DISCLOSURE_RE = /<details className="rr-sync-row-shell">/;
const USE_STATE_RE = /useState\(/;
const REVIEW_LABEL_RE = /reviewLabel = "need review"/;
const REVIEW_CARDS_COPY_RE = /Review the cards below\./;
const OLD_ALL_CLEAR_COPY_RE = /band\.allClear \? `Nothing needs you right now\. \$\{RESET_NOTE\}` : RESET_NOTE/;
const FAILURE_SECTION_ORDER_RE =
  /const FAILURE_SECTION_ORDER = \["needsOwner", "review", "systemIssue", "working", "notMeasured", "other"\]/;
const FAILURE_CARD_SECTION_RE = /function FailureCardSection\(/;
const FAILURE_CARD_SECTIONS_CALL_RE = /failureCardSections\(model\.failureCards\)/;
const FAILURE_CARD_SOURCE_WORK_RE = /data-source-work=\{card\.work\?\.group \?\? "other"\}/;
const SYNCS_OVERVIEW_LIST_RUNS_RE = /listRuns\(\{\s*limit:\s*SYNCS_OVERVIEW_RUN_LIMIT\s*\}\)/;

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

test("syncs first-paint run feed is bounded to the overview budget", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const limitMatch = src.match(SYNCS_OVERVIEW_RUN_LIMIT_RE);

  assert.ok(limitMatch, "runs page must name its first-paint run feed limit");
  assert.ok(Number(limitMatch[1]) <= 25, "syncs overview must not hydrate a deep run history before first paint");
  assert.match(src, SYNCS_OVERVIEW_LIST_RUNS_RE, "syncs overview must use the bounded first-paint run feed limit");
});
