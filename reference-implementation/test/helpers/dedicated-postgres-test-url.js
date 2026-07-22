// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fixed dedicated database and the per-file database names allocated by
 * `scripts/run-tests.js`. Keep this grammar narrow: it is an authorization
 * boundary for real-Postgres test lanes, not a general Postgres URL parser.
 */
export function isDedicatedPostgresTestDatabaseName(candidate) {
  return candidate === "pdpp_test" || /^pdpp_test_[a-z0-9_]{1,40}_[1-9][0-9]*$/.test(candidate);
}

/**
 * Returns the caller-supplied URL only when it targets the dedicated,
 * loopback-only PostgreSQL test listener and either the fixed test database
 * or a unique per-file database allocated by `scripts/run-tests.js`.
 * Credentials stay in the process environment instead of being repeated in
 * source, reports, or receipts.
 */
export function dedicatedPostgresTestUrl(candidate) {
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'postgresql:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.port !== '55447' ||
      decodeURIComponent(parsed.username) !== 'postgres' ||
      !isDedicatedPostgresTestDatabaseName(decodeURIComponent(parsed.pathname.slice(1)))
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}
