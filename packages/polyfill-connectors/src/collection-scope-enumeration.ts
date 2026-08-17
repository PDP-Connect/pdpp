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
 * Split a path-ish string into non-empty, dot-segment-normalized segments,
 * tolerating either separator.
 *
 * Comparison is segment-wise rather than by string prefix so a root of `proj`
 * cannot accidentally select `proj-secrets`: `startsWith` would match it, which
 * would silently widen the owner's declared boundary.
 *
 * `.` is dropped and `..` pops the preceding segment, so containment is decided
 * on the resolved path rather than its spelling. Without this, `/a/proj/../../etc`
 * compares as contained in `/a/proj` — the "exact by construction" claim would
 * hold only for well-formed walker output, not for an arbitrary declared root.
 * A `..` that would escape the start is dropped rather than retained, so a root
 * can never climb above its own first segment and widen itself.
 */
function segments(value: string): string[] {
  const parts = value
    .split(PATH_SEPARATORS)
    .flatMap((part) => part.split(sep))
    .filter((part) => part.length > 0 && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved;
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
 * TIMEZONE, resolved from real Codex data rather than assumed. Codex names its
 * rollout directories and filenames in the host's LOCAL time, but the records
 * inside carry UTC timestamps. Verified against `~/.codex/sessions`: a rollout
 * at `2025/11/09/rollout-2025-11-09T17-03-26-*.jsonl` holds
 * `"timestamp":"2025-11-09T23:03:26.107Z"` (a 6h offset), and across a 40-file
 * sample 3 files sat in a directory whose day differs from their own UTC day
 * (e.g. dir `2025-12-14` holding `2025-12-15T01:37:23Z`).
 *
 * So a directory day D can legitimately contain records dated up to D+1 in UTC
 * — and, west of UTC, down to D. Comparing the boundary against D alone would
 * therefore prune a directory that still holds in-range records whenever the
 * host is behind UTC. The rule is widened by one full day in the keep
 * direction: a day is pruned only when it is strictly before `since`'s day
 * MINUS one. That is conservative under every fixed offset (|offset| < 24h), so
 * it can over-scan by at most one day's directory but can never skip a
 * possibly-in-range one. Over-scanning costs time; over-pruning would silently
 * drop owner data while still reporting the stream covered.
 *
 * Partial dates (a year with no month, a month with no day) are compared at the
 * precision supplied, so a walker can prune whole years and months before
 * listing them — with the same one-unit margin applied at that precision.
 * Unparseable input returns `true`: an unreadable boundary must never silently
 * exclude data.
 */
/**
 * The calendar day before an ISO `yyyy-mm-dd`, as the same ISO shape.
 *
 * Used to widen the pruning boundary by one day so a local-time directory can
 * never be pruned while it may still hold a UTC record at or after the bound.
 * Falls back to the input if it cannot be advanced, which keeps the caller's
 * fail-open contract (never silently exclude data).
 */
function previousCalendarDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return day;
  }
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

export function dateDirectoryInRange(
  parts: { readonly day?: string | null; readonly month?: string | null; readonly year: string },
  scope: EnumerationScope | null | undefined
): boolean {
  const since = typeof scope?.since === "string" ? scope.since.trim() : "";
  if (!since) {
    return true;
  }
  const declaredDay = since.slice(0, 10);
  if (!ISO_DATE.test(declaredDay)) {
    return true;
  }
  // Widen by one calendar day (see the timezone note above): the directory day
  // is local, the records are UTC, so a directory named D-1 can still hold a
  // record at or after a boundary falling on D.
  const boundary = previousCalendarDay(declaredDay);
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
  // The boundary day itself straddles the instant, so it is never pruned;
  // `boundary` is already one day earlier than declared, per the timezone note.
  return day >= boundary.slice(8, 10);
}

/**
 * Whether a flattened project-directory name denotes a path inside a declared
 * root.
 *
 * Claude Code stores each project under `~/.claude/projects/` as a single
 * directory whose name is the project's absolute path with the separators
 * replaced by `-` (e.g. `/home/u/code/pdpp` -> `-home-u-code-pdpp`). An owner
 * declaring a root types the natural thing — `/home/u/code/pdpp` — so matching
 * their input against the raw flattened name would find nothing and silently
 * collect an empty set.
 *
 * Decoding the name back to a path is impossible: `-` is also a legal character
 * inside a real directory name, so `-a-b` is ambiguous between `/a/b` and
 * `/a-b`. Encoding the ROOT is not ambiguous, so the comparison runs in that
 * direction instead.
 *
 * Two encodings are accepted because both appear in real corpora and the choice
 * is a Claude Code version detail, verified against a live `~/.claude/projects`
 * of 2,347 directories: `/home/u/.tmp/x` appears as `-home-u--tmp-x` (dot folded
 * into `-`) while `/home/u/code/p/.claude/worktrees/w` appears as
 * `...-p-.claude-worktrees-w` (dot preserved). Accepting either is the sound
 * direction: rejecting one would silently exclude real projects.
 *
 * A bare relative root (no separator, e.g. `pdpp`) is matched as a trailing
 * path SEGMENT, so an owner can name a project without typing its full path.
 * The match is still segment-anchored — `pdpp` does not select `pdpp-secrets` —
 * because the encoded form is compared on `-` boundaries, not by substring.
 */
export function projectDirMatchesSourceRoots(projectDir: string, scope: EnumerationScope | null | undefined): boolean {
  const roots = normalizeRoots(scope?.source_roots);
  if (roots.length === 0) {
    return true;
  }
  return roots.some((root) => {
    const parts = segments(root);
    if (parts.length === 0) {
      return true;
    }
    // Absolute/multi-segment roots: compare against both flattened encodings,
    // anchored at a `-` boundary so a sibling with a longer name cannot match.
    const dotFolded = `-${parts.join("-").replace(/\./g, "-")}`;
    const dotKept = `-${parts.join("-")}`;
    for (const encoded of new Set([dotFolded, dotKept])) {
      if (projectDir === encoded || projectDir.startsWith(`${encoded}-`)) {
        return true;
      }
    }
    // Bare single-segment root: accept it only as the FINAL segment of the
    // flattened name.
    //
    // It cannot also match mid-name. `-` is ambiguous — it encodes a path
    // separator AND occurs inside real directory names — so `-proj-secrets` is
    // indistinguishable from the project `/…/proj/secrets` and the project
    // `/…/proj-secrets`. Treating a mid-name `-proj-` as a match would select
    // `proj-secrets` whenever the owner asked for `proj`, silently widening
    // their boundary. Requiring the final segment is the reading that can never
    // over-select; an owner who means a nested project can name its full path.
    if (parts.length === 1 && !(root.includes("/") || root.includes("\\") || root.includes(sep))) {
      return projectDir.endsWith(`-${parts[0]}`);
    }
    return false;
  });
}

/**
 * Stable fingerprint of the boundary a run enumerated under, stamped onto the
 * coverage records so it commits with the evidence it qualifies.
 *
 * MUST stay byte-identical to the runner's `collectorScopeFingerprint` and the
 * contract's `collectionScopeFingerprint` -- the server compares them to decide
 * whether stored proof still describes the declared scope, so drift would
 * silently invalidate valid proof or validate stale proof. `unscoped` is a real
 * value: a full pass is a declared boundary too.
 */
export function enumerationScopeFingerprint(scope: EnumerationScope | null | undefined): string {
  const since = typeof scope?.since === "string" ? scope.since.trim() : "";
  const validSince = since && !Number.isNaN(Date.parse(since)) ? since : "";
  const roots = normalizeRoots(scope?.source_roots).slice().sort();
  const parts: string[] = [];
  if (validSince) {
    parts.push(`since=${validSince}`);
  }
  if (roots.length > 0) {
    parts.push(`roots=${roots.join(",")}`);
  }
  return parts.length > 0 ? parts.join(";") : "unscoped";
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
