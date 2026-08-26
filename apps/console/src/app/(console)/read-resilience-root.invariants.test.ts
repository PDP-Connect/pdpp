// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-resilience acceptance invariants for the console ROOT error boundary
 * (`(console)/error.tsx`) — deliberately DIFFERENT from the leaf-segment
 * boundaries (`sources/error.tsx`, `syncs/error.tsx`, etc.), which now all
 * retry unbounded forever.
 *
 * The root boundary catches errors from ANYWHERE in the segment not already
 * caught by a more specific nested boundary, including the dashboard
 * overview `page.tsx` — which already fault-isolates every one of ITS OWN
 * data reads via `safeRead()`, so an error reaching this root boundary is
 * either (a) the same known RSC stream-teardown race the leaf boundaries
 * handle, now unprovable-by-route, or (b) a genuine unhandled fault in
 * render/layout code. There is no error-reporting integration in this
 * codebase, so `console.error` here is the only diagnostic signal an
 * operator has for (b); retrying that forever, silently, would delete the
 * signal for a real crash.
 *
 * So the root boundary:
 *   - absorbs the SLVP-standard case the same way the leaf boundaries do —
 *     quiet skeleton, no failure copy, capped backoff — for a BOUNDED number
 *     of attempts;
 *   - falls back to the pre-existing "Something went wrong" panel only after
 *     that bound is exceeded, which is strictly no worse than its prior
 *     immediate-failure-panel behavior and materially better for the common
 *     transient case.
 *
 * These invariants pin: the quiet phase exists and matches the leaf
 * boundaries' properties (skeleton reuse, module-scope counter, no failure
 * copy during the quiet phase); the bound is finite and explicit (NOT
 * unbounded, unlike every leaf boundary); and the terminal fallback panel is
 * still reachable (this must not become an infinite silent retry loop that
 * hides a genuine crash).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ERROR_FILE = `${HERE}error.tsx`;

const USES_LOADING_SKELETON_RE = /<ListLoadingSkeleton\b/;
const IMPORTS_LOADING_SKELETON_RE = /from\s+["']\.\/components\/route-loading\.tsx["']/;
const RECOVERING_TESTID_RE = /data-testid="dashboard-read-recovering"/;
const IMPORTS_SHARED_RETRY_RE = /from\s+["']\.\/components\/read-resilient-retry\.ts["']/;
const MODULE_SCOPE_COUNTER_RE = /const retryCounter = createRetryCounter\(\)/;
const CALLS_RESET_RE = /reset\(\)/;
const SCHEDULES_RETRY_RE = /setTimeout\([\s\S]*reset\(\)/;
const BOUNDED_ATTEMPTS_RE = /MAX_QUIET_ATTEMPTS/;
const NUMERIC_BOUND_RE = /const MAX_QUIET_ATTEMPTS = \d+/;
const HAS_TERMINAL_FALLBACK_RE = /Something went wrong/;
const HAS_TRY_AGAIN_BUTTON_RE = /Try again/;
const HAS_SIGN_IN_LINK_RE = /Sign in again/;
const SERVER_ONLY_IMPORT_RE = /^import[\s\S]*?from\s+["'][^"']*(owner-token|server-only|data-source|ref-client)/m;

test("the boundary has a quiet phase that reuses the shared skeleton and retry primitive, module-scoped", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, IMPORTS_LOADING_SKELETON_RE);
  assert.match(src, USES_LOADING_SKELETON_RE);
  assert.match(src, RECOVERING_TESTID_RE);
  assert.match(src, IMPORTS_SHARED_RETRY_RE);
  assert.match(src, MODULE_SCOPE_COUNTER_RE);
  assert.match(src, CALLS_RESET_RE);
  assert.match(src, SCHEDULES_RETRY_RE);
});

test("unlike every leaf-segment boundary, the root retry is explicitly BOUNDED, not unbounded", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(
    src,
    BOUNDED_ATTEMPTS_RE,
    "the root boundary must cap quiet retries so a genuine crash eventually surfaces"
  );
  assert.match(src, NUMERIC_BOUND_RE);
});

test("the boundary still has a reachable terminal fallback panel after the quiet phase is exhausted", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, HAS_TERMINAL_FALLBACK_RE);
  assert.match(src, HAS_TRY_AGAIN_BUTTON_RE);
  assert.match(src, HAS_SIGN_IN_LINK_RE);
});

test("the boundary is self-contained: no server-only import", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.doesNotMatch(src, SERVER_ONLY_IMPORT_RE);
});
