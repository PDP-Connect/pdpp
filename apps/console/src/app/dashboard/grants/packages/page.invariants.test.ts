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

const DETAIL_HREF_RE = /\/dashboard\/grants\/packages\/\$\{encodeURIComponent\(pkg\.package_id\)\}/;
const TYPED_HELPER_RE = /listGrantPackages\(\)/;
const NO_FETCH_RE = /\bfetch\s*\(/;
const FORBIDDEN_FIELDS_RE = /\b(access_token|refresh_token|token_hash|package_secret|client_secret)\b/;

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
