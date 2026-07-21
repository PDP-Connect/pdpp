/**
 * Returns the caller-supplied URL only when it targets the dedicated,
 * loopback-only PostgreSQL test listener. Credentials stay in the process
 * environment instead of being repeated in source, reports, or receipts.
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
      parsed.pathname !== '/pdpp_test'
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}
