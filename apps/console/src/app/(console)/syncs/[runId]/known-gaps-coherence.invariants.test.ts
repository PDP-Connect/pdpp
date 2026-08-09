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
 * The first fix for that replaced the footnote with "{n} streams were skipped
 * without saying why. The connector did not record a reason." Reported by the
 * owner again, 2026-08-08: that copy is false twice. The connector DOES record
 * a reason on each skip event (`data.reason`, with `data.diagnostics` naming
 * the failing field); the first fix read the recovery hint instead. And the
 * count is of skipped RECORDS — the owner saw "304 streams were skipped" for
 * 304 records dropped inside a single stream.
 *
 * The rules pinned here:
 *   1. Explain partial coverage only when there IS partial coverage.
 *   2. Never claim "no missing sources" while skips went unrecorded — the
 *      honest answer then is "unknown", not all-clear.
 *   3. Render the reason the connector recorded. Claim none was recorded only
 *      for the skips that genuinely carry none.
 *   4. Count records in records. An item count is never a stream count.
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
    /if \(skipped\.count === 0\) \{\s*return \(\s*<p[^>]*>\s*This run reported no missing sources\./,
    "an all-clear must not render while there were skips"
  );
});

/**
 * Live copy only. The defect is documented in comments above the fix, and
 * that reference must not be mistaken for what the page renders — the same
 * precaution the "old copy" test below already takes.
 */
async function readPageWithoutComments(): Promise<string> {
  return (await readFile(PAGE_FILE, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("skips report the reason the connector recorded, and count records not streams", async () => {
  const src = await readPageWithoutComments();
  // The reason lives on the skip event and must be rendered. The old copy
  // pinned here ("skipped without saying why") asserted the opposite and was
  // false on every run whose connector did record one.
  assert.doesNotMatch(src, /skipped without saying why/, "never blanket-claim no reason was recorded");
  assert.match(src, /summarizeSkippedStreams\(events\)/, "the section must be fed the reason-bearing skip summary");
  assert.match(src, /skipped\.reasons\.map/, "recorded reasons must be rendered");
  // Unit: skip events count records, so the copy must not label them streams.
  assert.doesNotMatch(src, /\{skippedCount\} stream/, "an item count must never be labelled a stream count");
  assert.match(src, /record\$\{skipped\.count === 1 \? "" : "s"\}/, "the skip count must be stated in records");
});

test("the unknown-outcome claim is scoped to skips that genuinely recorded no reason", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    /skipped\.unexplainedCount > 0 \? \(/,
    "the 'cannot tell you whether anything is missing' line must be gated on unexplained skips"
  );
  assert.match(src, /cannot tell you whether anything is missing/, "and must still be stated when they exist");
});

test("connector-authored failing-field diagnostics are surfaced", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /entry\.diagnostics\.path/, "the failing field path must be shown");
  assert.match(src, /entry\.diagnostics\.message/, "along with the validator message for it");
});

test("the old self-contradicting copy is no longer rendered", async () => {
  // Strip comments first: the defect is documented in a comment above the fix,
  // and that reference must not be mistaken for live copy.
  const src = (await readFile(PAGE_FILE, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /No partial source-coverage gaps were reported/);
  assert.doesNotMatch(src, /without terminal gap\s*\n?\s*details/);
});
