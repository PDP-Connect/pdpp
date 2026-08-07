// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "Known source gaps" section must not contradict itself.
 *
 * Reported by the owner from a live GroupMe run, 2026-08-07. The section
 * rendered, in this order:
 *
 *   Known source gaps
 *   Partial coverage means flushed records may be useful, but this run did not
 *     collect every requested source.
 *   No partial source-coverage gaps were reported. Protocol failures are shown
 *     separately below.
 *   Timeline includes 18 skipped stream events without terminal gap details.
 *
 * Three statements that cannot all be the point of one section: it explained a
 * problem, denied the problem, then footnoted 18 unexplained skips — which is
 * the very thing the denial implied had not happened.
 *
 * The rules pinned here:
 *   1. Explain partial coverage only when there IS partial coverage.
 *   2. Never claim "no missing sources" while streams were silently skipped —
 *      the honest answer then is "unknown", not all-clear.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

test("the partial-coverage explanation is gated on there being coverage gaps", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    /\{coverageGaps\.length > 0 \? \(\s*<p className="pdpp-caption text-muted-foreground">/,
    "the explanation must render only when coverageGaps is non-empty"
  );
});

test("the no-missing-sources claim is gated on nothing being silently skipped", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    /skippedCount === 0 \? \(\s*<p[^>]*>\s*This run reported no missing sources\./,
    "an all-clear must not render while skippedCount > 0"
  );
});

test("silently-skipped streams are reported as unknown, not as a clean run", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /skipped without saying why/, "the skip must state that no reason was recorded");
  assert.match(src, /cannot tell you whether anything is missing/, "and that the outcome is therefore unknown");
});

test("the old self-contradicting copy is no longer rendered", async () => {
  // Strip comments first: the defect is documented in a comment above the fix,
  // and that reference must not be mistaken for live copy.
  const src = (await readFile(PAGE_FILE, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /No partial source-coverage gaps were reported/);
  assert.doesNotMatch(src, /without terminal gap\s*\n?\s*details/);
});
