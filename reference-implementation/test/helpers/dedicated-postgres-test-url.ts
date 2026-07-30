// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fixed dedicated database and the per-file database names allocated by
 * `scripts/run-tests.ts`. Keep this grammar narrow: it is an authorization
 * boundary for real-Postgres test lanes, not a general Postgres URL parser.
 *
 * The grammar is structural, matching
 * `deriveDedicatedPostgresDbNameForFile`'s exact three-part shape
 * (`scripts/dedicated-postgres-db-name.ts`) rather than one loosely bounded
 * middle blob, so it cannot be satisfied by an arbitrary unbounded name that
 * merely happens to end in alphanumerics:
 *
 *   pdpp_test_<base:1-38 chars>_<runnerId:8 hex chars>_<counter:base36>
 *
 *   - `base` (file-derived, `.slice(0, 38)`) is capped at 38 chars.
 *   - `runnerId` is always exactly 8 lowercase hex chars
 *     (`randomBytes(4).toString("hex")`) — fixed-length, not bounded-range,
 *     so it cannot be confused with the adjacent free-form segments.
 *   - `counter` is `fileCounter.toString(36)` — BASE-36, so it contains
 *     lowercase LETTERS (`a`-`z`) once the counter passes 9, not only
 *     digits. A prior `[1-9][0-9]*` (decimal-only) pattern here rejected
 *     every allocation past the ninth in a run, which every real test suite
 *     reaches almost immediately. Requiring the runnerId as its own fixed
 *     8-hex-char anchor immediately before it (rather than folding it into
 *     one loosely bounded blob) is what keeps a base-36 counter from being
 *     confused with an arbitrary trailing word.
 *
 * (See `test/run-tests-dedicated-postgres-db-name-grammar.test.ts` for the
 * mutation proof that a narrower or looser grammar fails deterministically
 * in either direction — rejecting real names, or accepting unbounded ones.)
 */
export function isDedicatedPostgresTestDatabaseName(candidate: string): boolean {
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  return candidate === "pdpp_test" || /^pdpp_test_[a-z0-9_]{1,38}_[0-9a-f]{8}_[a-z0-9]+$/.test(candidate);
}

/**
 * Returns the caller-supplied URL only when it targets the dedicated,
 * loopback-only PostgreSQL test listener and either the fixed test database
 * or a unique per-file database allocated by `scripts/run-tests.js`.
 * Credentials stay in the process environment instead of being repeated in
 * source, reports, or receipts.
 */
export function dedicatedPostgresTestUrl(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "postgresql:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "55447" ||
      decodeURIComponent(parsed.username) !== "postgres" ||
      // `pg` applies query-string connection options after parsing authority
      // and the path. Reject them entirely so they cannot redirect the
      // effective host, port, user, or database for a real-Postgres lane.
      parsed.search ||
      parsed.hash ||
      !isDedicatedPostgresTestDatabaseName(decodeURIComponent(parsed.pathname.slice(1)))
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}
