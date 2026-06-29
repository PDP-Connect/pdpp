/**
 * Read-resilience acceptance invariants for the records segment [Defect 3].
 *
 * The owner hit "Couldn't load your connections" — all 19 cards gone — during a
 * reference rebuild, when a transient read failed mid `router.refresh()`. These
 * pin the fix so it cannot regress to a full-viewport blank:
 *
 *   1. The records error boundary first renders quiet retrying copy, not an
 *      explicit failure headline, and the eventual failure state is still a
 *      partial banner rather than a full-viewport takeover.
 *   2. The boundary reads a CLIENT-cached last-known marker (it must not import
 *      a server-only module) and surfaces last-known status + a retry.
 *   3. The boundary auto-retries once so a transient blip self-heals.
 *   4. The poller stamps the last-good read time and guards the soft
 *      revalidation so a throw never escapes the timer.
 *
 * Source-regex over the shipped client components, mirroring the existing
 * records-list-view / sources-ia invariant style: these are `"use client"`
 * React components that the behavioral marker logic (last-known-read.test.ts)
 * already covers as a pure unit; here we pin the boundary's structural copy and
 * the load-bearing wiring from source.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ERROR_FILE = `${HERE}error.tsx`;
const POLLER_FILE = `${HERE}records-page-poller.tsx`;
const MARKER_FILE = `${HERE}last-known-read.ts`;

// Regexes hoisted to module scope (project lint: useTopLevelRegex).
const BANNER_TESTID_RE = /data-testid="records-read-failure-banner"/;
const PENDING_TESTID_RE = /data-testid="records-read-retry-pending"/;
const PENDING_COPY_RE = /Refreshing source status/;
const FAILURE_HEADLINE_RE = /Couldn't refresh your connections/;
const FAILURE_GATED_AFTER_RETRY_RE = /if\s*\(!autoRetried\)[\s\S]*records-read-retry-pending[\s\S]*return\s*\(/;
const FULL_VIEWPORT_TAKEOVER_RE = /min-h-\[60vh\]/;
const READ_FAILURE_FRAMING_RE = /read failure, not a change/;
const READS_MARKER_HELPER_RE = /readLastRecordsReadAt/;
const IMPORTS_MARKER_RE = /from "\.\/last-known-read\.ts"/;
const LAST_SUCCESSFUL_LOAD_COPY_RE = /Last successful load/;
const OVERCLAIMED_LAST_KNOWN_COPY_RE = /Showing last-known status/i;
const SERVER_ONLY_IMPORT_RE = /^import[\s\S]*?from\s+["'][^"']*(owner-token|server-only|data-source|ref-client)/m;
const RETRY_TESTID_RE = /data-testid="records-read-failure-retry"/;
const CALLS_RESET_RE = /reset\(\)/;
const AUTO_RETRY_DELAY_RE = /AUTO_RETRY_DELAY_MS/;
const AUTO_RETRIED_GUARD_RE = /autoRetried/;
const POLLER_STAMPS_FRESH_RE = /markRecordsReadFresh/;
const GUARDED_REFRESH_RE = /try\s*\{[\s\S]*router\.refresh\(\)[\s\S]*\}\s*catch/;
const MARKER_GUARDS_WINDOW_RE = /typeof window/;
const ANY_IMPORT_RE = /^import\s/m;

test("the records error boundary retries quietly before rendering explicit failure copy", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, PENDING_TESTID_RE);
  assert.match(src, PENDING_COPY_RE);
  assert.match(src, FAILURE_HEADLINE_RE);
  assert.match(src, FAILURE_GATED_AFTER_RETRY_RE);
});

test("the records persistent-failure state is a partial banner, not a full-viewport blank", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  // A banner (section/role=status), not the full-height centered takeover the
  // generic segment-error shell uses.
  assert.match(src, BANNER_TESTID_RE);
  assert.doesNotMatch(src, FULL_VIEWPORT_TAKEOVER_RE, "the records boundary must not be a full-viewport takeover");
  // Honest framing: a read failure, not a data change.
  assert.match(src, READ_FAILURE_FRAMING_RE);
});

test("the boundary surfaces last-known status from a client-cached marker, never a server read", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  // Reads the client-side marker…
  assert.match(src, READS_MARKER_HELPER_RE);
  assert.match(src, IMPORTS_MARKER_RE);
  // …and reports the last successful load without claiming to render cached
  // source rows.
  assert.match(src, LAST_SUCCESSFUL_LOAD_COPY_RE);
  assert.doesNotMatch(src, OVERCLAIMED_LAST_KNOWN_COPY_RE);
  // Self-contained: no server-only module is *imported* into the boundary.
  // (The doc comment may name `server-only` to explain why it is avoided; we
  // scan import statements, not prose.)
  assert.doesNotMatch(src, SERVER_ONLY_IMPORT_RE);
});

test("the boundary offers a retry and auto-recovers once", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, RETRY_TESTID_RE);
  assert.match(src, CALLS_RESET_RE);
  // A single automatic recovery attempt (guarded so it never loops).
  assert.match(src, AUTO_RETRY_DELAY_RE);
  assert.match(src, AUTO_RETRIED_GUARD_RE);
});

test("the poller stamps the last-good read time and guards the soft revalidation", async () => {
  const src = await readFile(POLLER_FILE, "utf8");
  assert.match(src, POLLER_STAMPS_FRESH_RE);
  // The refresh call is wrapped so a synchronous throw can't escape the timer.
  assert.match(src, GUARDED_REFRESH_RE);
});

test("the last-known marker module stays pure and SSR-safe", async () => {
  const src = await readFile(MARKER_FILE, "utf8");
  // Guards `window`/`sessionStorage` so it can be called from SSR/node without
  // throwing, and pulls in no React or server-only dependency.
  assert.match(src, MARKER_GUARDS_WINDOW_RE);
  // No imports at all — the marker is dependency-free. (Prose may mention
  // `server-only`; we scan import statements only.)
  assert.doesNotMatch(src, ANY_IMPORT_RE);
});
