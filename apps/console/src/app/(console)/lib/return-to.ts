/**
 * Open-redirect sanitizer for owner-console return paths.
 *
 * Used by both `proxy.ts` and the owner DAL (e.g. `owner-token.ts`) to
 * normalize a user-supplied `return_to` value before redirecting back into the
 * console after owner-session login. The console owner routes are clean
 * top-level nouns (`/`, `/sources`, `/syncs`, `/audit`, `/explore`, `/grants`,
 * `/connect`, `/schedules`, and the clean deployment/admin nouns), with the
 * legacy `/dashboard*` paths still accepted so a bookmarked login round-trip
 * from an old link lands back where it started (the redirect layer then sends
 * the owner on to the clean route). Any value that is not a safe same-origin
 * owner path collapses to `/` (the overview).
 */

const C0_CONTROL_END = 0x1f;
const DEL = 0x7f;

/**
 * Clean owner-route prefixes plus the legacy `/dashboard` prefix. A safe
 * `return_to` must begin with one of these (as the whole path or followed by a
 * `/`, `?`, or `#`), so an attacker cannot smuggle `/owner/login`-style loops
 * or arbitrary same-origin paths through the login round-trip.
 */
const OWNER_ROUTE_PREFIXES = [
  "/sources",
  "/syncs",
  "/audit",
  "/explore",
  "/grants",
  "/connect",
  "/schedules",
  "/deployment",
  "/device-exporters",
  "/event-subscriptions",
  "/search",
  "/stream-playground",
  "/dashboard",
] as const;

// Character-code scan instead of a regex literal. A regex form with
// C0 or DEL escapes trips Biome's noControlCharactersInRegex, and the
// RegExp-constructor workaround trips useRegexLiterals. This explicit
// loop matches the same rejection set (C0: 0x00-0x1F, DEL: 0x7F).
function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= C0_CONTROL_END || code === DEL) {
      return true;
    }
  }
  return false;
}

/** Is `input` an owner route: the bare overview `/`, or one of the known owner prefixes at a segment boundary? */
function isOwnerRoute(input: string): boolean {
  if (input === "/") {
    return true;
  }
  for (const prefix of OWNER_ROUTE_PREFIXES) {
    if (input === prefix) {
      return true;
    }
    if (input.startsWith(prefix)) {
      const next = input.charAt(prefix.length);
      if (next === "/" || next === "?" || next === "#") {
        return true;
      }
    }
  }
  return false;
}

export function normalizeDashboardReturnTo(input: string | null | undefined): string {
  if (typeof input !== "string" || !input) {
    return "/";
  }
  if (input.startsWith("//")) {
    return "/";
  }
  if (input.includes("\\")) {
    return "/";
  }
  if (containsControlChar(input)) {
    return "/";
  }
  if (!isOwnerRoute(input)) {
    return "/";
  }
  return input;
}
