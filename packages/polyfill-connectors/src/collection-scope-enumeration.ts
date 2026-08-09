// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Enumeration-level scope bounding for filesystem-class local collectors.
 *
 * Why this module exists, stated plainly: filtering records at emission time
 * does NOT bound the work. A connector that walks every session file in an
 * 8.6 GB corpus, opens each one, and JSON-parses it line by line has already
 * paid the full cost by the time the shared `emitRecord` gate drops an
 * out-of-range record. Emission filtering makes the OUTPUT honest; only
 * enumeration filtering makes the RUN bounded.
 *
 * So this module answers one question, before any file is opened:
 *
 *   Is this path even eligible to be read under the declared boundary?
 *
 * The rules are deliberately conservative in one direction: a source is skipped
 * ONLY when the boundary can be shown to exclude it. Anything the boundary
 * cannot definitively rule out is still opened and left to the emission gate,
 * which is already correct. Under-skipping costs time; over-skipping would
 * silently drop owner data and fabricate a coverage claim, so the asymmetry is
 * intentional.
 *
 * Two kinds of boundary are supported, and the difference matters:
 *
 * - **Path containment (`source_roots`)** — EXACT. An owner names the roots
 *   (project directories, session roots) they want collected. Membership is a
 *   decidable property of the path itself, so a non-matching subtree is skipped
 *   with certainty and no data can be missed inside a selected root.
 *
 * - **Date-encoded paths (`since`)** — EXACT, but only where the SOURCE LAYOUT
 *   itself encodes the date (e.g. Codex's `sessions/yyyy/mm/dd/`). A calendar
 *   day strictly before the boundary day cannot contain a record at or after
 *   the boundary, so pruning that subtree is sound by construction.
 *
 * Deliberately NOT supported: skipping a file because its mtime precedes
 * `since`. mtime is not a sound upper bound on the timestamps a file's CONTENTS
 * carry — an append-only transcript is rewritten/touched by unrelated events, a
 * restored backup or `git checkout` resets it, and a file whose mtime is old can
 * still hold in-range records if the clock moved or the writer back-dated. Using
 * it as proof would mean silently not reading owner data while still reporting
 * the stream as covered, which is exactly the fabricated watermark this contract
 * forbids. If a future source proves mtime IS an upper bound for its layout, it
 * can opt in explicitly — it must not be the default.
 *
 * Pure and connector-agnostic: no connector identifiers, no I/O. Connectors call
 * these helpers from their own walk; the runtime never learns a connector name.
 */

import { sep } from "node:path";

const PATH_SEPARATORS = /[\\/]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_SEGMENT = /^\d{4}$/;
const TWO_DIGIT_SEGMENT = /^\d{2}$/;

/** The owner-declared boundary, as connectors consume it. */
export interface EnumerationScope {
  readonly since?: string | null;
  readonly source_roots?: readonly string[] | null;
}

function normalizeRoots(roots: readonly string[] | null | undefined): readonly string[] {
  if (!Array.isArray(roots)) {
    return [];
  }
  const out = new Set<string>();
  for (const root of roots) {
    if (typeof root === "string" && root.trim()) {
      out.add(root.trim());
    }
  }
  return [...out];
}

/**
 * Split a path-ish string into non-empty segments, tolerating either separator.
 *
 * Comparison is segment-wise rather than by string prefix so a root of `proj`
 * cannot accidentally select `proj-secrets`: `startsWith` would match it, which
 * would silently widen the owner's declared boundary.
 */
function segments(value: string): string[] {
  return value
    .split(PATH_SEPARATORS)
    .flatMap((part) => part.split(sep))
    .filter((part) => part.length > 0 && part !== ".");
}

/**
 * Whether `candidate` is inside (or exactly equal to) `root`, by whole segments.
 *
 * Also true when the candidate is a PARENT of the root: a walker must be allowed
 * to descend through `a/` to reach the selected root `a/b/c`. Callers that mean
 * "is this leaf selected" should use {@link isPathWithinSourceRoots}, which does
 * not admit parents.
 */
export function pathContainsOrIsWithin(root: string, candidate: string): boolean {
  const rootParts = segments(root);
  const candidateParts = segments(candidate);
  if (rootParts.length === 0) {
    return true;
  }
  const shared = Math.min(rootParts.length, candidateParts.length);
  for (let i = 0; i < shared; i += 1) {
    if (rootParts[i] !== candidateParts[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a concrete source path falls inside at least one declared root.
 *
 * With no roots declared, every path is in scope — an absent boundary is not a
 * boundary. A path that merely CONTAINS a root (i.e. is an ancestor of it) is
 * not itself selected; use {@link shouldDescendIntoDirectory} while walking.
 */
export function isPathWithinSourceRoots(candidate: string, scope: EnumerationScope | null | undefined): boolean {
  const roots = normalizeRoots(scope?.source_roots);
  if (roots.length === 0) {
    return true;
  }
  const candidateParts = segments(candidate);
  return roots.some((root) => {
    const rootParts = segments(root);
    if (rootParts.length > candidateParts.length) {
      return false;
    }
    return rootParts.every((part, i) => part === candidateParts[i]);
  });
}

/**
 * Whether a walker should descend into a directory at all.
 *
 * True when the directory is inside a declared root OR is an ancestor on the way
 * to one. Everything else is pruned before its contents are ever listed, which
 * is where the I/O saving actually comes from.
 */
export function shouldDescendIntoDirectory(directory: string, scope: EnumerationScope | null | undefined): boolean {
  const roots = normalizeRoots(scope?.source_roots);
  if (roots.length === 0) {
    return true;
  }
  return roots.some((root) => pathContainsOrIsWithin(root, directory) || pathContainsOrIsWithin(directory, root));
}

/**
 * Whether a calendar day directory can hold records at or after `since`.
 *
 * Sound because the layout itself carries the date: every record under
 * `yyyy/mm/dd` belongs to that civil day, so a day strictly before the
 * boundary's day cannot contain an in-range record. The boundary day itself is
 * always kept — it straddles the instant, and per-record filtering resolves it.
 *
 * Partial dates (a year with no month, a month with no day) are compared at the
 * precision supplied, so a walker can prune whole years and months before
 * listing them. Unparseable input returns `true`: an unreadable boundary must
 * never silently exclude data.
 */
export function dateDirectoryInRange(
  parts: { readonly day?: string | null; readonly month?: string | null; readonly year: string },
  scope: EnumerationScope | null | undefined
): boolean {
  const since = typeof scope?.since === "string" ? scope.since.trim() : "";
  if (!since) {
    return true;
  }
  const boundary = since.slice(0, 10);
  if (!ISO_DATE.test(boundary)) {
    return true;
  }
  const year = parts.year.trim();
  if (!YEAR_SEGMENT.test(year)) {
    return true;
  }
  if (year !== boundary.slice(0, 4)) {
    return year > boundary.slice(0, 4);
  }
  const month = parts.month?.trim();
  if (!month) {
    return true;
  }
  if (!TWO_DIGIT_SEGMENT.test(month)) {
    return true;
  }
  if (month !== boundary.slice(5, 7)) {
    return month > boundary.slice(5, 7);
  }
  const day = parts.day?.trim();
  if (!day) {
    return true;
  }
  if (!TWO_DIGIT_SEGMENT.test(day)) {
    return true;
  }
  // The boundary day itself straddles the instant, so it is never pruned.
  return day >= boundary.slice(8, 10);
}

/**
 * Whether the declared boundary bounds enumeration at all.
 *
 * Lets a connector report honestly that a run was enumeration-bounded rather
 * than merely emission-filtered — the distinction this whole module exists for.
 */
export function scopeBoundsEnumeration(scope: EnumerationScope | null | undefined): boolean {
  if (!scope) {
    return false;
  }
  const since = typeof scope.since === "string" ? scope.since.trim() : "";
  return normalizeRoots(scope.source_roots).length > 0 || since.length > 0;
}

/**
 * Read the boundary a connector should enforce out of its requested stream
 * scopes.
 *
 * Connectors receive `requested` from the runtime; the boundary is carried on
 * the stream scopes the runtime already threads through, so no new channel and
 * no connector-specific config is needed. `source_roots` rides alongside
 * `time_range` on the same scope entry.
 */
export function readEnumerationScope(
  requested: ReadonlyMap<string, { readonly source_roots?: unknown; readonly time_range?: { since?: string } }>,
  streams: readonly string[]
): EnumerationScope | null {
  for (const stream of streams) {
    const scope = requested.get(stream);
    if (!scope) {
      continue;
    }
    const since = scope.time_range?.since;
    const roots = Array.isArray(scope.source_roots)
      ? scope.source_roots.filter((r): r is string => typeof r === "string")
      : [];
    if ((typeof since === "string" && since) || roots.length > 0) {
      return {
        ...(typeof since === "string" && since ? { since } : {}),
        ...(roots.length > 0 ? { source_roots: roots } : {}),
      };
    }
  }
  return null;
}
