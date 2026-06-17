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
    /href=\{dashboardRoutes\.connector\(card\.connectionId\)\}\s+prefetch=\{false\}/,
    "owner-action source links must not prefetch dynamic source detail routes"
  );
  assert.match(
    src,
    /href=\{`\$\{dashboardRoutes\.section\.runs\}\?connector_id=\$\{encodeURIComponent\(card\.connectorId\)\}`\}\s+prefetch=\{false\}/,
    "failure-card run filter links must not prefetch dynamic runs routes"
  );
  assert.match(
    src,
    /href=\{row\.browseHref\}\s+prefetch=\{false\}/,
    "stream browse links must not prefetch dynamic explore routes"
  );
});

test("syncs view stays server-rendered by default", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.doesNotMatch(src, /^["']use client["'];?/m, "runs must not hydrate the entire syncs view");
  assert.match(src, /<details className="rr-sync-row-shell">/, "row details should use native disclosure");
  assert.doesNotMatch(src, /useState\(/, "page-wide row disclosure state would force full-page client hydration");
});

test("syncs first-paint run feed is bounded to the overview budget", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const limitMatch = src.match(SYNCS_OVERVIEW_RUN_LIMIT_RE);

  assert.ok(limitMatch, "runs page must name its first-paint run feed limit");
  assert.ok(
    Number(limitMatch[1]) <= 25,
    "syncs overview must not hydrate a deep run history before first paint"
  );
  assert.match(
    src,
    /listRuns\(\{\s*limit:\s*SYNCS_OVERVIEW_RUN_LIMIT\s*\}\)/,
    "syncs overview must use the bounded first-paint run feed limit"
  );
});
