// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Static guard tests for the narrowed `/search` page (console
 * app). Mirrors the web app's guards from `narrow-search-to-spine-jump`.
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
const WARNINGS_BANNER_RE = /\b(?:WarningsBanner|dedupeWarnings)\b/;
const RECORD_HITS_RE = /\bhits:\s*/;
const EXPLORE_REDIRECT_LITERAL_RE = /redirect\(`\/explore\?q=\$\{encodeURIComponent\(query\)\}`\)/;
const EXPLORE_REDIRECT_ROUTES_RE =
  /redirect\(`\$\{dashboardRoutes\.section\.explore\}\?q=\$\{encodeURIComponent\(query\)\}`\)/;
const SPINE_EXACT_RESULT_RE = /spineResult\.exact/;
const EXACT_JUMP_OPT_OUT_RE = /jump\s*!==\s*["']0["']/;

test("the console search page does not import the rs-client record-search helpers", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    RECORD_SEARCH_SYMBOL_RE,
    "search/page.tsx must not call searchRecordsLexical / searchRecordsHybrid / searchRecordsSemantic / getRecord"
  );
  assert.doesNotMatch(src, RS_CLIENT_IMPORT_RE, "search/page.tsx must not import from rs-client");
});

test("the console search page does not render retrieval notice or record-result warnings", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, RETRIEVAL_NOTICE_RE, "search/page.tsx must not surface retrieval-state notices");
  assert.doesNotMatch(
    src,
    WARNINGS_BANNER_RE,
    "search/page.tsx must not render WarningsBanner; record-result warnings retired"
  );
  assert.doesNotMatch(src, RECORD_HITS_RE, "search/page.tsx must not pass record hits to the view");
});

test("the console search page redirects free-text submits to Explore", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.ok(
    EXPLORE_REDIRECT_LITERAL_RE.test(src) || EXPLORE_REDIRECT_ROUTES_RE.test(src),
    "search/page.tsx must call redirect() to /explore?q=<query> on free-text submit"
  );
});

test("the console search page preserves exact-id jump redirects", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    SPINE_EXACT_RESULT_RE,
    "search/page.tsx must keep the exact-id branch that powers trace/grant/run deep links"
  );
  assert.match(src, EXACT_JUMP_OPT_OUT_RE, "search/page.tsx must keep the jump=0 opt-out for exact-id redirects");
});
