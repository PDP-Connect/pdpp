/**
 * Asserts that dashboard and doc copy advertises canonical `pdpp ref ...`
 * commands rather than the legacy bare aliases (`pdpp run`, `pdpp grant`,
 * `pdpp trace`). Legacy aliases remain as repo-local compatibility shims but
 * must not appear in surfaced copy.
 *
 * See openspec/changes/unify-pdpp-cli-command-surface/design.md §6.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

async function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

// Legacy bare aliases that must not appear as surfaced commands in copy.
// Pattern matches the command string as it would appear in a template literal
// or JSX text node, but not inside comments or inside the word "pdpp ref".
const LEGACY_RUN_TIMELINE = /`pdpp run timeline|>pdpp run timeline/;
const LEGACY_GRANT_TIMELINE = /`pdpp grant timeline|>pdpp grant timeline/;
const LEGACY_TRACE_SHOW = /`pdpp trace show|>pdpp trace show/;

// Files in my ownership scope that surface CLI copy.
const SURFACED_FILES = [
  "apps/web/src/app/dashboard/runs/page.tsx",
  "apps/web/src/app/dashboard/runs/[runId]/page.tsx",
  "apps/web/src/app/dashboard/grants/page.tsx",
  "apps/web/src/app/dashboard/grants/[grantId]/page.tsx",
  "apps/web/src/app/dashboard/traces/page.tsx",
  "apps/web/src/app/dashboard/traces/[traceId]/page.tsx",
  "apps/web/src/app/dashboard/components/peek.tsx",
  "apps/web/src/app/dashboard/components/views/timeline-detail-view.tsx",
  "apps/web/content/docs/reference-implementation.md",
];

// Canonical patterns that must appear in the reference doc.
const CANONICAL_REF_RUN = /pdpp ref run timeline/;
const CANONICAL_REF_GRANT = /pdpp ref grant timeline/;
const CANONICAL_REF_TRACE = /pdpp ref trace show/;

test("no surfaced file advertises legacy bare pdpp run/grant/trace aliases", async () => {
  for (const relPath of SURFACED_FILES) {
    const src = await read(relPath);
    assert.equal(
      LEGACY_RUN_TIMELINE.test(src),
      false,
      `${relPath}: found legacy 'pdpp run timeline' — use 'pdpp ref run timeline'`,
    );
    assert.equal(
      LEGACY_GRANT_TIMELINE.test(src),
      false,
      `${relPath}: found legacy 'pdpp grant timeline' — use 'pdpp ref grant timeline'`,
    );
    assert.equal(
      LEGACY_TRACE_SHOW.test(src),
      false,
      `${relPath}: found legacy 'pdpp trace show' — use 'pdpp ref trace show'`,
    );
  }
});

test("reference-implementation.md advertises canonical pdpp ref commands", async () => {
  const src = await read("apps/web/content/docs/reference-implementation.md");
  assert.match(src, CANONICAL_REF_RUN);
  assert.match(src, CANONICAL_REF_GRANT);
  assert.match(src, CANONICAL_REF_TRACE);
});

test("cli README advertises pdpp ref namespace", async () => {
  const src = await read("packages/cli/README.md");
  assert.match(src, /pdpp ref/);
  assert.match(src, /pdpp connect/);
});
