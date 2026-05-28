/**
 * Source-regex guard for the grant detail page.
 *
 * The grant detail page is the natural discovery jump for event
 * subscriptions registered against a grant. The console offers a
 * read-only list at `/dashboard/event-subscriptions?grant_id=<id>`; this
 * test keeps the discovery link from regressing into a generic Records
 * subnav or a hand-rolled URL string.
 *
 * Spec: openspec/changes/add-mcp-event-subscription-client-tools and
 *       openspec/changes/add-client-event-subscription-management
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const SUBSCRIPTIONS_HREF_RE = /\/dashboard\/event-subscriptions\?grant_id=/;
const ENCODE_URI_RE = /encodeURIComponent\(grantId\)/;
const COPY_RE = /Event subscriptions for this grant/i;

const PACKAGE_PIVOT_LOOKUP_RE = /lookupGrantPackageIdForGrant\(/;
const PACKAGE_PIVOT_HREF_RE = /\/dashboard\/grants\/packages\/\$\{encodeURIComponent\(packageId\)\}/;
const PACKAGE_PIVOT_COPY_RE = /Parent grant package/i;

test("grant detail page links to filtered event-subscriptions list", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SUBSCRIPTIONS_HREF_RE);
  assert.match(src, ENCODE_URI_RE);
  assert.match(src, COPY_RE);
});

test("grant detail page surfaces a parent-package pivot link when the grant is package-bound", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The page MUST resolve the parent package via the typed helper, render
  // the pivot href through encodeURIComponent, and only show the link
  // when `packageId` is non-null (a conditional render around the helper
  // result). The copy below is the operator-visible affordance pinned
  // against silent drift.
  assert.match(src, PACKAGE_PIVOT_LOOKUP_RE);
  assert.match(src, PACKAGE_PIVOT_HREF_RE);
  assert.match(src, PACKAGE_PIVOT_COPY_RE);
});
