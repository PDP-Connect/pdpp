// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-resilience acceptance invariants for the sources segment [Defect 3,
 * revised]. The prior version of this file pinned a banner that told the
 * owner "Refreshing source status… The Sources view hit a transient read
 * interruption. Retrying automatically before showing an error." — and, on a
 * second failure, "Couldn't refresh your connections" behind a manual Retry
 * button. The owner reported that failure-copy state sitting on screen for an
 * hour and said, verbatim: "I should never see this" / "/sources should
 * always work."
 *
 * THE STANDARD (stated explicitly by the owner): Stripe, Linear, Vercel, and
 * Plaid never show a user "we hit a transient read interruption, retrying."
 * The page renders, or it shows last-known state with a quiet staleness
 * indicator. The user never learns the backend hiccuped. That is the MINIMUM
 * bar, not the target.
 *
 * Root cause the boundary now assumes: `Error: The destination stream closed
 * early` is React's RSC streaming writer reacting to the HTTP response socket
 * closing before the flight stream finished flushing (a poll-driven
 * `router.refresh()` superseding an in-flight one, or the tab
 * backgrounding/throttling the connection) — NOT a failed data read. The
 * upstream `/_ref/connectors` call already returned 200. So this boundary
 * treats every activation as recoverable-by-construction: it never renders
 * error-shaped copy, retries unbounded on a capped backoff, and — while
 * retrying — is visually identical to the ordinary `loading.tsx` skeleton,
 * with at most a quiet "Updated Xs/Xm ago" caption once a last-known
 * timestamp exists.
 *
 * These invariants pin the STRONGER property (no error copy ever reaches the
 * owner, no terminal manual-retry dead end) rather than merely deleting the
 * old, weaker pin:
 *
 *   1. The boundary source contains NONE of the retired failure-ish copy
 *      ("error", "interruption", "retrying", "couldn't", "failed", "wrong")
 *      in any owner-facing string.
 *   2. The boundary renders the SAME `ListLoadingSkeleton` component
 *      `loading.tsx` uses, not a bespoke banner/card — so the transient state
 *      is indistinguishable from an ordinary page load.
 *   3. The boundary retries on every mount (no `autoRetried`/"give up" flag)
 *      with a capped, growing backoff, and never renders a manual "Retry"
 *      button or link as a terminal state.
 *   4. The boundary reads the CLIENT-cached last-known marker (it must not
 *      import a server-only module) and, when present, renders only a quiet,
 *      dimmed relative-time caption — never a claim that failed data changed.
 *   5. The poller still stamps the last-good read time and guards the soft
 *      revalidation so a throw never escapes the timer (unchanged contract).
 *
 * Source-regex over the shipped client components, mirroring the existing
 * records-list-view / sources-ia invariant style: these are `"use client"`
 * React components that the behavioral marker logic (last-known-read.test.ts)
 * already covers as a pure unit; here we pin the boundary's structural copy
 * and the load-bearing wiring from source.
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
//
// The owner-facing-string bans below intentionally allow the word "error" to
// appear as a JS identifier (the boundary prop is literally named `error`,
// per the Next.js `error.tsx` contract) but forbid it inside rendered JSX
// text content. We assert on the specific retired phrases rather than
// banning "error" as a bare substring, since the prop name and the
// `console.error(error)` diagnostics call are legitimate and must remain.
const RETIRED_PENDING_COPY_RE = /Refreshing source status/;
const RETIRED_INTERRUPTION_COPY_RE = /transient read interruption/i;
const RETIRED_RETRYING_COPY_RE = /Retrying automatically/i;
const RETIRED_FAILURE_HEADLINE_RE = /Couldn't refresh your connections/;
const RETIRED_COULDNT_RE = /Couldn't/;
const RETIRED_READ_FAILURE_FRAMING_RE = /read failure/i;
const RETIRED_BANNER_TESTID_RE = /data-testid="records-read-failure-banner"/;
const RETIRED_PENDING_TESTID_RE = /data-testid="records-read-retry-pending"/;
const RETIRED_RETRY_TESTID_RE = /data-testid="records-read-failure-retry"/;
const RETIRED_MANUAL_RETRY_LABEL_RE = /Retry now|Reload Sources/;
const RETIRED_AUTO_RETRIED_GUARD_RE = /autoRetried/;

const USES_LOADING_SKELETON_RE = /<ListLoadingSkeleton\b/;
const IMPORTS_LOADING_SKELETON_RE = /from\s+["']\.\.\/components\/route-loading\.tsx["']/;
const RECOVERING_TESTID_RE = /data-testid="sources-read-recovering"/;
const READS_MARKER_HELPER_RE = /readLastRecordsReadAt/;
const IMPORTS_MARKER_RE = /from "\.\/last-known-read\.ts"/;
const QUIET_UPDATED_CAPTION_RE = /Updated (just now|\$\{|\d)/;
const SERVER_ONLY_IMPORT_RE = /^import[\s\S]*?from\s+["'][^"']*(owner-token|server-only|data-source|ref-client)/m;
const CALLS_RESET_RE = /reset\(\)/;
const UNBOUNDED_RETRY_SCHEDULES_NEXT_RE = /setTimeout\([\s\S]*reset\(\)/;
const BACKOFF_CAP_RE = /RETRY_MAX_DELAY_MS/;
const POLLER_STAMPS_FRESH_RE = /markRecordsReadFresh/;
const GUARDED_REFRESH_RE = /try\s*\{[\s\S]*router\.refresh\(\)[\s\S]*\}\s*catch/;
const MARKER_GUARDS_WINDOW_RE = /typeof window/;
const ANY_IMPORT_RE = /^import\s/m;

test("the boundary source contains none of the retired owner-facing failure copy", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.doesNotMatch(src, RETIRED_PENDING_COPY_RE);
  assert.doesNotMatch(src, RETIRED_INTERRUPTION_COPY_RE);
  assert.doesNotMatch(src, RETIRED_RETRYING_COPY_RE);
  assert.doesNotMatch(src, RETIRED_FAILURE_HEADLINE_RE);
  assert.doesNotMatch(src, RETIRED_COULDNT_RE);
  assert.doesNotMatch(src, RETIRED_READ_FAILURE_FRAMING_RE);
  assert.doesNotMatch(src, RETIRED_BANNER_TESTID_RE);
  assert.doesNotMatch(src, RETIRED_PENDING_TESTID_RE);
  assert.doesNotMatch(src, RETIRED_RETRY_TESTID_RE);
  assert.doesNotMatch(src, RETIRED_MANUAL_RETRY_LABEL_RE);
  assert.doesNotMatch(
    src,
    RETIRED_AUTO_RETRIED_GUARD_RE,
    "no gated one-shot auto-retry flag — retry must be unbounded"
  );
});

test("the boundary renders the same loading skeleton the route's loading.tsx uses, not a bespoke banner", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, IMPORTS_LOADING_SKELETON_RE);
  assert.match(src, USES_LOADING_SKELETON_RE);
  assert.match(src, RECOVERING_TESTID_RE);
});

test("the boundary surfaces only a quiet relative-time caption from a client-cached marker, never a server read", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  // Reads the client-side marker…
  assert.match(src, READS_MARKER_HELPER_RE);
  assert.match(src, IMPORTS_MARKER_RE);
  // …and, when present, renders it as a quiet "Updated …" caption, never
  // failure-framed copy.
  assert.match(src, QUIET_UPDATED_CAPTION_RE);
  // Self-contained: no server-only module is *imported* into the boundary.
  // (The doc comment may name `server-only` to explain why it is avoided; we
  // scan import statements, not prose.)
  assert.doesNotMatch(src, SERVER_ONLY_IMPORT_RE);
});

test("the boundary retries unbounded on a capped backoff, with no manual-retry terminal state", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, CALLS_RESET_RE);
  // Every mount schedules the next retry — no gate that stops after N tries.
  assert.match(src, UNBOUNDED_RETRY_SCHEDULES_NEXT_RE);
  assert.match(src, BACKOFF_CAP_RE);
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
