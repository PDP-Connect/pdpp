/**
 * Structural assertions for the stream-health page's graceful handling of a
 * 404/410 from the resource server.
 *
 * Why a file-grep style test, not a render test: the page is a React Server
 * Component that imports `next/navigation` and other Next runtime modules, so it
 * cannot be imported into a plain node test. We pin the source to the exact
 * branches a future refactor must preserve, mirroring the sibling
 * `../page-stream-unavailable.test.ts` (stream list) and
 * `../[recordKey]/page-record-not-found.test.ts` (record detail).
 *
 * Why this page needed the fix: `streamHealth()` samples records via
 * `queryRecords` → `authedFetch`, which throws the typed `ResourceServerHttpError`
 * on a non-OK response. A stream dropped from the manifest makes that records
 * read return 404 (live-confirmed: `GET /v1/streams/commits/records` → 404). The
 * page is reachable from the stream list page's "Stream health →" link, so a
 * stale/retired stream must degrade calmly here too instead of rethrowing to the
 * records segment error boundary ("Couldn't load your connections").
 *
 * The contract the health page is required to honor:
 *
 *   - It MUST import the typed `ResourceServerHttpError` from owner-token so it
 *     can branch on status, not let a generic `Error` flow to the error
 *     boundary.
 *
 *   - When `streamHealth` throws `ResourceServerHttpError` with status 404 (or
 *     410 Gone), the page MUST render a bounded "stream health is not available"
 *     state inside the dashboard shell — not crash to `error.tsx`.
 *
 *   - The `ReferenceServerUnreachableError` branch (transport failure) MUST be
 *     preserved as the distinct "RS unreachable" outcome.
 *
 *   - Unknown errors (anything else) MUST still throw so the segment error
 *     boundary at `apps/console/src/app/dashboard/records/error.tsx` shows the
 *     generic recovery surface.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_HTTP_ERROR =
  /import\s*\{[^}]*ResourceServerHttpError[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/owner-token\.ts"/;
const PRESERVES_UNREACHABLE_BRANCH = /err\s+instanceof\s+ReferenceServerUnreachableError/;
const DETECTS_HTTP_404_410 =
  /err\s+instanceof\s+ResourceServerHttpError\s*&&\s*\(err\.status\s*===\s*404\s*\|\|\s*err\.status\s*===\s*410\)/;
const BOUNDED_STATE_COPY = /not\s+available/i;
const RETHROWS_UNKNOWN = /throw\s+err;/;

test("stream health page imports the typed ResourceServerHttpError so it can branch on status", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_HTTP_ERROR);
});

test("stream health page preserves the ReferenceServerUnreachableError transport-failure branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PRESERVES_UNREACHABLE_BRANCH);
});

test("stream health page detects a 404 or 410 from the resource server and renders a bounded state", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DETECTS_HTTP_404_410);
  assert.match(src, BOUNDED_STATE_COPY);
});

test("stream health page still rethrows unknown errors so the segment error boundary catches them", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RETHROWS_UNKNOWN);
});
