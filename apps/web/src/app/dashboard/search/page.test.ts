/**
 * Static guard tests for the narrowed `/dashboard/search` page.
 *
 * After `narrow-search-to-spine-jump`, the page is a spine artifact
 * lookup utility (traces, grants, runs by id). It must not call the
 * public record-search endpoints and must redirect free-text submits
 * to Explore so record content search lives on one surface.
 *
 * These checks are string-level guards (no rendering) so they survive
 * refactors cheaply and trip the moment record-search re-enters this
 * page.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const RECORD_SEARCH_SYMBOL_RE = /\b(?:searchRecordsLexical|searchRecordsHybrid|searchRecordsSemantic|getRecord)\b/;
const RS_CLIENT_IMPORT_RE = /from\s+["'][^"']*\brs-client(?:\.ts)?["']/;
const RETRIEVAL_NOTICE_RE = /\b(?:RetrievalNotice|buildRetrievalNotice|RetrievalDebug)\b/;
const RECORD_HITS_RE = /\bhits:\s*/;
const EXPLORE_REDIRECT_EXPLICIT_RE = /redirect\(`\/dashboard\/explore\?q=\$\{encodeURIComponent\(query\)\}`\)/;
const EXPLORE_REDIRECT_VIA_ROUTES_RE =
  /redirect\(`\$\{dashboardRoutes\.section\.explore\}\?q=\$\{encodeURIComponent\(query\)\}`\)/;
const SPINE_EXACT_RE = /spineResult\.exact/;
const JUMP_OPT_OUT_RE = /jump\s*!==\s*["']0["']/;

test("the live search page does not import the rs-client record-search helpers", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    RECORD_SEARCH_SYMBOL_RE,
    "search/page.tsx must not call searchRecordsLexical / searchRecordsHybrid / searchRecordsSemantic / getRecord"
  );
  assert.doesNotMatch(src, RS_CLIENT_IMPORT_RE, "search/page.tsx must not import from rs-client");
});

test("the live search page does not render retrieval notice or debug surfaces", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, RETRIEVAL_NOTICE_RE, "search/page.tsx must not surface retrieval-state notices");
  assert.doesNotMatch(src, RECORD_HITS_RE, "search/page.tsx must not pass record hits to the view");
});

test("the live search page redirects free-text submits to Explore", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Free-text submit (not jump=0, not an exact spine match) must redirect to
  // /dashboard/explore?q=<query>. Accept either the literal URL or the
  // dashboardRoutes.section.explore reference, since either form satisfies
  // the contract.
  assert.ok(
    EXPLORE_REDIRECT_EXPLICIT_RE.test(src) || EXPLORE_REDIRECT_VIA_ROUTES_RE.test(src),
    "search/page.tsx must call redirect() to /dashboard/explore?q=<query> on free-text submit"
  );
});

test("the live search page preserves exact-id jump redirects", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    SPINE_EXACT_RE,
    "search/page.tsx must keep the exact-id branch that powers trace/grant/run deep links"
  );
  assert.match(src, JUMP_OPT_OUT_RE, "search/page.tsx must keep the jump=0 opt-out for exact-id redirects");
});
