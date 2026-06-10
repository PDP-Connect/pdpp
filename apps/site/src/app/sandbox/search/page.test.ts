/**
 * Static guard tests for the sandbox `/sandbox/search` page.
 *
 * `narrow-search-to-spine-jump` retired record-content search from the
 * Search surface; the sandbox must mirror that scope. The page should
 * only call the sandbox data source's spine search (`refSearch`) and
 * must redirect free-text submits to the sandbox Explore.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const SANDBOX_RECORD_SEARCH_RE = /\bds\.searchRecords[A-Za-z]*\b/;
const SANDBOX_EXPLORE_EXPLICIT_REDIRECT_RE = /redirect\(`\/sandbox\/explore\?q=\$\{encodeURIComponent\(query\)\}`\)/;
const SANDBOX_EXPLORE_ROUTE_REDIRECT_RE =
  /redirect\(`\$\{sandboxRoutes\.section\.explore\}\?q=\$\{encodeURIComponent\(query\)\}`\)/;

test("the sandbox search page does not call ds.searchRecords* methods", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    SANDBOX_RECORD_SEARCH_RE,
    "sandbox/search/page.tsx must not call any ds.searchRecords* method; record search lives on Explore"
  );
});

test("the sandbox search page redirects free-text submits to /sandbox/explore", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.ok(
    SANDBOX_EXPLORE_EXPLICIT_REDIRECT_RE.test(src) || SANDBOX_EXPLORE_ROUTE_REDIRECT_RE.test(src),
    "sandbox/search/page.tsx must redirect free-text submits to /sandbox/explore"
  );
});
