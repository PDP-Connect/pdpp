// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-resilience acceptance invariants for the device-exporters segment,
 * mirroring `sources/read-resilience.invariants.test.ts`. See that file and
 * `syncs/read-resilience.invariants.test.ts` for the full standard this
 * pattern enforces; this file pins the same properties for
 * `/device-exporters`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ERROR_FILE = `${HERE}error.tsx`;

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Strip `/* ... *‍/` block comments before checking for retired owner-facing
 * copy. The boundary's doc comment legitimately QUOTES the retired phrases
 * (to explain what this pattern replaces and why) — that is documentation,
 * not rendered JSX text, so it must not trip the ban.
 */
function withoutBlockComments(src: string): string {
  return src.replace(BLOCK_COMMENT_RE, "");
}

const RETIRED_COULDNT_RE = /Couldn't/;
const RETIRED_ERROR_HEADING_RE = /Read error/;
const RETIRED_TRY_AGAIN_RE = /Try again/;
const RETIRED_INTERRUPTION_COPY_RE = /transient read interruption/i;
const RETIRED_READ_FAILURE_FRAMING_RE = /read failure/i;
const RETIRED_BACK_LINK_RE = /Back to device exporters/;
const RETIRED_SEGMENT_ERROR_IMPORT_RE = /from\s+["']\.\.\/components\/segment-error\.tsx["']/;

const USES_LOADING_SKELETON_RE = /<ListLoadingSkeleton\b/;
const IMPORTS_LOADING_SKELETON_RE = /from\s+["']\.\.\/components\/route-loading\.tsx["']/;
const RECOVERING_TESTID_RE = /data-testid="device-exporters-read-recovering"/;
const SERVER_ONLY_IMPORT_RE = /^import[\s\S]*?from\s+["'][^"']*(owner-token|server-only|data-source|ref-client)/m;
const CALLS_RESET_RE = /reset\(\)/;
const UNBOUNDED_RETRY_SCHEDULES_NEXT_RE = /setTimeout\([\s\S]*reset\(\)/;
const MODULE_SCOPE_COUNTER_RE = /const retryCounter = createRetryCounter\(\)/;
const NO_REACT_STATE_COUNTER_RE = /useState\(/;
const IMPORTS_SHARED_RETRY_RE = /from\s+["']\.\.\/components\/read-resilient-retry\.ts["']/;
const NO_TERMINAL_GIVE_UP_FLAG_RE = /gaveUp|autoRetried|maxAttemptsReached/;

test("the boundary source contains none of the retired owner-facing failure copy outside doc comments", async () => {
  const rawSrc = await readFile(ERROR_FILE, "utf8");
  const src = withoutBlockComments(rawSrc);
  assert.doesNotMatch(src, RETIRED_COULDNT_RE);
  assert.doesNotMatch(src, RETIRED_ERROR_HEADING_RE);
  assert.doesNotMatch(src, RETIRED_TRY_AGAIN_RE);
  assert.doesNotMatch(src, RETIRED_INTERRUPTION_COPY_RE);
  assert.doesNotMatch(src, RETIRED_READ_FAILURE_FRAMING_RE);
  assert.doesNotMatch(src, RETIRED_BACK_LINK_RE);
  assert.doesNotMatch(rawSrc, RETIRED_SEGMENT_ERROR_IMPORT_RE);
});

test("the boundary renders the same loading skeleton the route's loading.tsx uses, not a bespoke banner", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, IMPORTS_LOADING_SKELETON_RE);
  assert.match(src, USES_LOADING_SKELETON_RE);
  assert.match(src, RECOVERING_TESTID_RE);
  // loading.tsx uses ListLoadingSkeleton label="device exporters" rows={5}.
  assert.match(src, /ListLoadingSkeleton label="device exporters" rows=\{5\}/);
});

test("the boundary retries unbounded on a capped backoff held at module scope, with no manual-retry terminal state", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.match(src, CALLS_RESET_RE);
  assert.match(src, UNBOUNDED_RETRY_SCHEDULES_NEXT_RE);
  assert.match(src, IMPORTS_SHARED_RETRY_RE);
  assert.match(src, MODULE_SCOPE_COUNTER_RE);
  assert.doesNotMatch(
    src,
    NO_REACT_STATE_COUNTER_RE,
    "the retry counter must live at module scope, not React state, or backoff never grows across remounts"
  );
  assert.doesNotMatch(src, NO_TERMINAL_GIVE_UP_FLAG_RE, "no gated give-up state — retry must be unbounded");
});

test("the boundary is self-contained: no server-only import", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.doesNotMatch(src, SERVER_ONLY_IMPORT_RE);
});
