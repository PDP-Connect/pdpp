// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A page the schema rejects is considered-but-NOT-covered.
 *
 * `runStream` previously declared coverage with `buildFullScanCoverageMessage`,
 * which forces `covered === considered`. That shape cannot express a dropped
 * page: the enumeration boundary absorbed the rejected row and the stream read
 * `complete` while a real page was silently missing. Notion's schema is strict
 * (title ≤ 4000 chars, url ≤ 4096, safe text), so rejection is genuinely
 * reachable, not theoretical.
 *
 * `covered` is now tallied per record from the same `validateRecord` verdict
 * the runtime's emitRecord applies, so a rejected page reads a real `partial`.
 *
 * The companion property — an ARCHIVED (deleted) page must still count as
 * covered — is asserted here too. Notion reports deletions in-band as
 * `archived: true`, and PDPP deliberately retains records the provider has
 * removed, so treating a deletion as a gap would make correct preservation look
 * like loss on every subsequent run.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "notion", "index.ts");
const GOOD_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BAD_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const ARCHIVED_PAGE_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

/** Runs the real connector against a bounded in-process Notion stub. */
async function runWithPages(pagesJson: string, state: Record<string, unknown> = {}): Promise<EmittedMessage[]> {
  const harnessDir = await mkdtemp(join(tmpdir(), "pdpp-notion-rejected-"));
  const wrapperPath = join(harnessDir, "notion-wrapper.mjs");
  await writeFile(
    wrapperPath,
    `
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  const isPage = body.filter?.value === "page";
  return new Response(JSON.stringify({
    has_more: false,
    next_cursor: null,
    results: isPage ? ${pagesJson} : []
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await import(${JSON.stringify(pathToFileURL(ENTRYPOINT).href)});
`,
    "utf8"
  );
  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: wrapperPath,
      env: { NOTION_API_TOKEN: "bounded-test-token" },
      start: { scope: { streams: [{ name: "pages" }] }, state, type: "START" },
    });
    return result.messages;
  } finally {
    await rm(harnessDir, { force: true, recursive: true });
  }
}

function pagesCoverage(messages: readonly EmittedMessage[]): { considered?: number; covered?: number } {
  const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "pages");
  assert.ok(coverage, "expected a pages DETAIL_COVERAGE");
  return coverage as { considered?: number; covered?: number };
}

/** A well-formed page. `titleText` is the only variable of interest. */
function page(id: string, titleText: string, archived = false): string {
  return JSON.stringify({
    id,
    object: "page",
    parent: { type: "workspace", workspace: true },
    properties: { Name: { type: "title", title: [{ plain_text: titleText }] } },
    url: `https://www.notion.so/${id.replace(/-/g, "")}`,
    archived,
    created_time: "2026-08-12T00:00:00.000Z",
    last_edited_time: "2026-08-12T01:00:00.000Z",
    created_by: { id: ACTOR_ID },
    last_edited_by: { id: ACTOR_ID },
  });
}

test("a page rejected by the schema is considered but not covered", async () => {
  // The second page's title exceeds the schema's 4000-char bound, so
  // `validateRecord` rejects it and it can never be committed.
  const messages = await runWithPages(`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "x".repeat(4001))}]`);

  const coverage = pagesCoverage(messages);
  assert.equal(coverage.considered, 2, "both enumerated pages are in the denominator");
  // The load-bearing assertion. Under `buildFullScanCoverageMessage` this was 2.
  assert.equal(coverage.covered, 1, "a page the schema rejected must not be claimed as covered");
});

test("an archived page still counts as covered, so deletion is not read as loss", async () => {
  // Notion reports a deleted page in-band as `archived: true`. It is a valid
  // record and the runtime tombstones it; it must NOT depress coverage, or
  // every upstream deletion would make a correct run look incomplete forever.
  const messages = await runWithPages(`[${page(GOOD_PAGE_ID, "Fine")}, ${page(ARCHIVED_PAGE_ID, "Gone", true)}]`);

  const coverage = pagesCoverage(messages);
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 2, "an archived (deleted) page is a covered fact, not a coverage gap");
});

test("a clean enumeration still reads fully covered", async () => {
  // Guards the opposite failure: a covered-tally that under-counts would make
  // every healthy run read a false `partial`.
  const messages = await runWithPages(`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "Also fine")}]`);

  const coverage = pagesCoverage(messages);
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 2);
});

test("a steady-state run whose cursor suppresses every page still reads fully covered", async () => {
  // The incremental path: a cursor newer than every page means nothing is
  // emitted. Those pages were still enumerated and accounted for — an earlier
  // run's identical content already passed the real shape-check — so they must
  // count as covered. If suppressed-unchanged rows were dropped from `covered`,
  // every healthy steady-state re-scan would report a false `partial`.
  const messages = await runWithPages(`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "Also fine")}]`, {
    pages: { last_edited_time: "2030-01-01T00:00:00.000Z" },
  });

  const emitted = messages.filter((m) => m.type === "RECORD" && m.stream === "pages").length;
  assert.equal(emitted, 0, "the cursor should suppress every page");

  const coverage = pagesCoverage(messages);
  assert.equal(coverage.considered, 2, "suppressed pages are still enumerated");
  assert.equal(coverage.covered, 2, "suppressed-unchanged pages are accounted for, not lost");
});
