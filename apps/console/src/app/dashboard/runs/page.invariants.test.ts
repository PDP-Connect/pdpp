import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("page.tsx", import.meta.url));

const REDIRECT_IMPORT_RE = /import\s+\{\s*redirect\s*\}\s+from\s+["']next\/navigation["']/;
const PEEK_REDIRECT_RE =
  /if\s*\(\s*params\.peek\s*\)\s*\{[\s\S]*redirect\(dashboardRoutes\.run\(params\.peek\)\);[\s\S]*\}/;
// The Syncs reskin fetches the runs feed inside a `Promise.all`, so the
// invariant is "the first `listRuns(` call appears after the peek redirect",
// not the old `result = await listRuns(` assignment shape.
const LIST_RUNS_RE = /\blistRuns\(/;
const RUN_TIMELINE_FETCH_RE = /\bgetRunTimeline\(/;

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
