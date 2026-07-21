/**
 * Structural assertions for the stream-records page's graceful handling of
 * a 404/410 from the resource server.
 *
 * Why a file-grep style test, not a render test: the page is a React Server
 * Component that imports `next/navigation` and other Next runtime modules,
 * so it cannot be imported into a plain node test. We instead pin the source
 * to the exact branches a future refactor must preserve, mirroring the
 * pattern in `apps/console/src/app/(console)/sources/actions.test.ts`.
 *
 * The contract the page is required to honor:
 *
 *   - It MUST import the typed `ResourceServerHttpError` from owner-token so
 *     it can branch on status, instead of letting a generic `Error` thrown by
 *     `authedFetch` flow to the segment error boundary.
 *
 *   - When `queryRecords` throws `ResourceServerHttpError` with status 404
 *     (or 410 Gone), the page MUST render a bounded "this stream is not
 *     available" state inside the dashboard shell - not crash to `error.tsx`.
 *     Owner-mode stream visibility is manifest-derived; once a stream is
 *     dropped from the manifest the records-read endpoint legitimately
 *     returns 404, and that is an expected end-state, not a runtime error.
 *
 *   - The `ReferenceServerUnreachableError` branch (transport failure) MUST
 *     be preserved as the existing distinct outcome: that is "the RS is
 *     unreachable", not "this stream is gone".
 *
 *   - Unknown errors (anything else) MUST still throw so the segment error
 *     boundary at `apps/console/src/app/(console)/sources/error.tsx` shows
 *     the generic "Couldn't load your connections" recovery surface.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_HTTP_ERROR =
  /import\s*\{[^}]*ResourceServerHttpError[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/lib\/owner-token\.ts"/;
const PRESERVES_UNREACHABLE_BRANCH = /err\s+instanceof\s+ReferenceServerUnreachableError/;
const DETECTS_HTTP_404 =
  /err\s+instanceof\s+ResourceServerHttpError\s*&&\s*\(err\.status\s*===\s*404\s*\|\|\s*err\.status\s*===\s*410\)/;
const BOUNDED_STATE_COPY = /not\s+available/i;
const RETHROWS_UNKNOWN = /throw\s+err;/;
const RS_CLIENT_THROWS_TYPED_HTTP_ERROR = /throw\s+new\s+ResourceServerHttpError\(path,\s*res\.status,\s*body\)/;

test("stream page imports the typed ResourceServerHttpError so it can branch on status", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_HTTP_ERROR);
});

test("stream page preserves the ReferenceServerUnreachableError transport-failure branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PRESERVES_UNREACHABLE_BRANCH);
});

test("stream page detects a 404 or 410 from the resource server and renders a bounded state", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DETECTS_HTTP_404);
  assert.match(src, BOUNDED_STATE_COPY);
});

test("stream page still rethrows unknown errors so the segment error boundary catches them", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RETHROWS_UNKNOWN);
});

test("rs-client.authedFetch throws the typed ResourceServerHttpError on non-OK responses", async () => {
  const rsClientPath = `${HERE}../../../lib/rs-client.ts`;
  const src = await readFile(rsClientPath, "utf8");
  // The typed error carries (path, status, body) so callers can branch on
  // status without re-parsing a string message.
  assert.match(
    src,
    RS_CLIENT_THROWS_TYPED_HTTP_ERROR,
    "authedFetch must throw ResourceServerHttpError on non-OK so callers can branch on status"
  );
});
