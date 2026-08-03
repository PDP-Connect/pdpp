// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex invariants for the grant-packages list page.
 *
 * The list page renders one Link per package into the detail page.
 * These tests pin three things that would silently regress under copy-
 * paste:
 *
 *   1. The detail href is built with `encodeURIComponent` over the
 *      package id, so reserved characters do not break the URL.
 *   2. The list reads from the typed `listGrantPackages` helper, never
 *      from a hand-rolled fetch.
 *   3. The page does not render any secret-shaped tokens — the storage
 *      layer never exposes them but a copy-paste from the grants page
 *      could leak `token` or `secret`-named fields.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const DETAIL_HREF_RE = /\/grants\/packages\/\$\{encodeURIComponent\(pkg\.package_id\)\}/;
const TYPED_HELPER_RE = /listGrantPackages\(/;
const NO_FETCH_RE = /\bfetch\s*\(/;
const FORBIDDEN_FIELDS_RE = /\b(access_token|refresh_token|token_hash|package_secret|client_secret)\b/;
const NEVER_USED_RE = /never used/i;
const LAST_USED_RE = /last used/i;
const SORTED_COLLECTION_RE = /\[\.\.\.result\.data\]\.sort\(byCleanupPriority\)/;
const GROUPED_PACKAGES_RE = /group\.packages\.map\(/;
const RESOLVED_CLIENT_NAME_RE = /pkg\.client\?\.client_name/;
const NO_NAME_HEURISTIC_RE = /new URL\(|clientOriginCaption|looksLikeTechnicalClientId/;
const PACKAGE_ID_TITLE_RE = /title=\{pkg\.package_id\}/;
const ISSUED_LABEL_RE = /issued <IcTimestamp/;
const CURRENT_GROUPS_RE = /groupPackages\(currentItems\)/;
const HISTORICAL_PACKAGES_RE = /Historical and revoked/;
const NEXT_CURSOR_RE = /result\.next_cursor/;
const CLIENT_FILTER_RE = /client_id=\$\{encodeURIComponent\(group\.clientId\)\}/;
const UNKNOWN_CLIENT_RE = /Unknown registered client/;
const UNNAMED_CLIENT_RE = /Unnamed registered client/;
const MISSING_CLIENT_RE = /if \(!pkg\.client\)/;
const COMMENTS_BLOCK_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /^\s*\/\/.*$/gm;
const TITLE_ATTRIBUTE_RE = /\stitle=\{?"[^"]*"\}?/g;

test("grant-packages list page builds detail hrefs through encodeURIComponent", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DETAIL_HREF_RE);
});

test("grant-packages list page reads from the typed ref-client helper, not a raw fetch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, TYPED_HELPER_RE);
  assert.doesNotMatch(src, NO_FETCH_RE);
});

test("grant-packages list page does not render secret-shaped fields", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, FORBIDDEN_FIELDS_RE);
});

// ─── Last-used / never-used cleanup affordance ─────────────────────────────
//
// Same evidence authority as the tokens page: derived from `disclosure.served`
// spine events on the package's child grants, never a stored column. The
// load-bearing case is NULL — a package that has never been read still holds
// live access across every child grant it wraps, and a live deployment has 25
// of 85 packages in exactly that state. If `null` renders as a blank cell, the
// packages most worth revoking become the least visible ones on the page.
//
// These guards strip comments and attribute values before matching. An earlier
// version of the tokens guard passed against a build where the rendered copy
// had been deleted but a comment still said "never used" — a guard that cannot
// fail certifies a regression as safe.
function renderedText(src: string): string {
  return src.replace(COMMENTS_BLOCK_RE, "").replace(LINE_COMMENT_RE, "").replace(TITLE_ATTRIBUTE_RE, "");
}

test("grant-packages page renders an explicit never-used state, not a blank cell", async () => {
  const body = renderedText(await readFile(PAGE_FILE, "utf8"));
  assert.match(body, NEVER_USED_RE);
  assert.match(body, LAST_USED_RE);
});

test("grant-packages page orders for cleanup and renders the sorted collection", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SORTED_COLLECTION_RE);
  assert.match(src, GROUPED_PACKAGES_RE);
});

// ─── Client-first IA (grants-ia-maker-0803) ────────────────────────────────

test("grant-packages list uses the resolved client name only when authoritative, never a URL/id heuristic", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RESOLVED_CLIENT_NAME_RE);
  assert.doesNotMatch(src, NO_NAME_HEURISTIC_RE);
});

test("grant-packages list still renders the raw package id as secondary data", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PACKAGE_ID_TITLE_RE);
});

test("grant-packages list labels the issuance timestamp Issued", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, ISSUED_LABEL_RE);
});

test("grant-packages list groups by client authorization, keeps historical evidence reachable, and paginates", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CURRENT_GROUPS_RE);
  assert.match(src, HISTORICAL_PACKAGES_RE);
  assert.match(src, NEXT_CURSOR_RE);
  assert.match(src, CLIENT_FILTER_RE);
});

test("grant-packages list never invents a missing client identity", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, UNKNOWN_CLIENT_RE);
  assert.match(src, UNNAMED_CLIENT_RE);
  assert.match(src, MISSING_CLIENT_RE);
});
