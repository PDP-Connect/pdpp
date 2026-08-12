#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance gate for the `no-direct-prepare` policy.
 *
 * Replaces the inline grep in lefthook.yml's
 * `reference-implementation:no-direct-prepare` job. Same policy, same regex,
 * same three whole-file exemptions — the only change is that grandfathered
 * call sites are now pinned at (path, line) granularity in
 * `direct-prepare-allowlist.ts` instead of being all-or-nothing per file.
 *
 * Invoked as: node check-direct-prepare-conformance.ts <staged files...>
 * Paths are repo-root-relative, exactly as lefthook expands {staged_files}.
 * Files outside the policy's scope (the lefthook `glob`) never reach here;
 * this script additionally re-applies the scope and exemption filters itself
 * so it behaves identically when run by hand over an arbitrary file list.
 *
 * Fails the commit on any of three divergences, mirroring
 * packages/polyfill-connectors/scripts/check-no-await-in-loops-conformance.ts:
 *
 *   1. NEW/UNLISTED — a direct-prepare hit whose (path, line) is not in the
 *      allowlist. Fires for a brand-new call site anywhere, INCLUDING a new
 *      one inside an already-allowlisted file.
 *   2. STALE — an allowlist row whose (path, line) no longer holds a
 *      direct-prepare hit, but whose file WAS inspected in this run. The code
 *      moved or was migrated; the exception must be re-reviewed, not carried
 *      forever. Only evaluated for inspected files: a row for a file that is
 *      not staged cannot be confirmed or refuted in this run, so it is left
 *      alone rather than being falsely reported stale.
 *   3. DUPLICATE — the same (path, line) listed twice in the allowlist. A
 *      structural defect in the checked-in data, checked BEFORE any file is
 *      read so it can never be masked by a live hit count that happens to
 *      line up.
 *
 * Deterministic: exact (path, line) matching against a narrow direct-prepare
 * scanner. The scanner permits whitespace between `db` / `getDb()` and
 * `.prepare(` so formatting cannot hide a production direct-prepare site.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DirectPrepareAllowlistEntry } from "./direct-prepare-allowlist.ts";
import { DIRECT_PREPARE_ALLOWLIST } from "./direct-prepare-allowlist.ts";

const DIRECT_PREPARE_PATTERN = /(^|[^a-zA-Z_])(db|getDb\(\))\s*\.\s*prepare\s*\(/g;

/**
 * Whole-file exemptions: the wrapper, the engine bootstrap, and the query
 * registry legitimately own the primitive. Unchanged from lefthook.yml.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "reference-implementation/lib/db.ts",
  "reference-implementation/server/db.ts",
  "reference-implementation/server/queries/index.ts",
]);

/** The policy's scope, mirroring the lefthook `glob`. */
const SCOPE_PATTERN = /^reference-implementation\/(lib|server|runtime|cli)\/.*\.(ts|js)$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface DirectPrepareLiveHit {
  line: number;
  path: string;
  text: string;
}

export function locationKey(entry: { path: string; line: number }): string {
  return `${entry.path}:${entry.line}`;
}

/**
 * Count occurrences of each location key. Used so a duplicate can be
 * reported explicitly rather than collapsing silently into a Set.
 */
export function countByLocationKey(entries: readonly { path: string; line: number }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = locationKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Files this run is responsible for: in scope, not whole-file exempt. */
export function selectInspectableFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0 && SCOPE_PATTERN.test(p) && !EXEMPT_PATHS.has(p)))].sort();
}

export function scanDirectPrepareText(path: string, contents: string): DirectPrepareLiveHit[] {
  const hits: DirectPrepareLiveHit[] = [];
  const lines = contents.split("\n");
  for (const match of contents.matchAll(DIRECT_PREPARE_PATTERN)) {
    const index = match.index ?? 0;
    const line = contents.slice(0, index).split("\n").length;
    hits.push({ line, path, text: lines[line - 1]?.trim() ?? "" });
  }
  return hits;
}

function scanFile(path: string): DirectPrepareLiveHit[] {
  let contents: string;
  try {
    contents = readFileSync(resolve(REPO_ROOT, path), "utf8");
  } catch {
    // Staged deletions/renames can name a path that no longer exists on
    // disk. Nothing to scan; the allowlist's stale check will surface a
    // genuinely removed site on the next run that does include the file.
    return [];
  }
  return scanDirectPrepareText(path, contents);
}

function reportUnlisted(unlisted: readonly DirectPrepareLiveHit[]): void {
  console.error(`\n✗ ${unlisted.length} NEW direct .prepare(...) call site(s) — not in the reviewed allowlist:`);
  for (const hit of unlisted) {
    console.error(`    ${hit.path}:${hit.line}  ${hit.text}`);
  }
  console.error("\n  Direct .prepare(...) is forbidden outside the wrapper.");
  console.error("  Use the typed wrapper primitives from lib/db.ts:");
  console.error("    getOne, getMany, iterate, exec,");
  console.error("    allowUnboundedReadAcknowledged, iterateDynamicSqlAcknowledged.");
  console.error("  Spec: openspec/specs/reference-implementation-architecture/spec.md");
  console.error("  Requirement: 'New direct DB prepare usage SHALL be blocked at the staged-file boundary'");
}

function reportStale(stale: readonly DirectPrepareAllowlistEntry[]): void {
  console.error(
    `\n✗ ${stale.length} STALE allowlist entr${stale.length === 1 ? "y" : "ies"} — no direct .prepare(...) at this location any more:`
  );
  for (const entry of stale) {
    console.error(`    ${entry.path}:${entry.line}  (${entry.category}: ${entry.note})`);
  }
  console.error(
    "\n  The code moved, changed shape, or was migrated to the wrapper. Re-review:" +
      " if the same grandfathered call still exists, update the line number;" +
      " if it was migrated, delete the row (that is the goal)."
  );
  console.error("  File: reference-implementation/scripts/direct-prepare-allowlist.ts");
}

function main(argv: readonly string[]): number {
  // Structural check FIRST, before any file is read, so a duplicate row can
  // never be masked by a live hit count that happens to add up.
  const duplicates = [...countByLocationKey(DIRECT_PREPARE_ALLOWLIST).entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    console.error(`\n✗ ${duplicates.length} DUPLICATE allowlist location key(s) in direct-prepare-allowlist.ts:`);
    for (const [key, count] of duplicates) {
      console.error(`    ${key} — listed ${count} times`);
    }
    console.error("\n  Each (path, line) must appear at most once; a duplicate defeats the exact-match guarantee.");
    return 1;
  }

  const files = selectInspectableFiles(argv);
  if (files.length === 0) {
    return 0;
  }

  const inspected = new Set(files);
  const live = files.flatMap(scanFile);
  const liveKeys = new Set(live.map(locationKey));
  const allowedKeys = new Set(DIRECT_PREPARE_ALLOWLIST.map(locationKey));

  const unlisted = live.filter((hit) => !allowedKeys.has(locationKey(hit)));
  // Only rows whose file was actually inspected can be judged stale.
  const stale = DIRECT_PREPARE_ALLOWLIST.filter(
    (entry) => inspected.has(entry.path) && !liveKeys.has(locationKey(entry))
  );

  if (unlisted.length === 0 && stale.length === 0) {
    return 0;
  }
  if (unlisted.length > 0) {
    reportUnlisted(unlisted);
  }
  if (stale.length > 0) {
    reportStale(stale);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
