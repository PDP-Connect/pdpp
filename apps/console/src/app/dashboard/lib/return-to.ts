/**
 * Open-redirect sanitizer for dashboard return paths.
 *
 * Used by both `proxy.ts` and the dashboard DAL (e.g. `owner-token.ts`)
 * to normalize a user-supplied `return_to` value before redirecting back
 * into the dashboard after owner-session login. Any value that is not a
 * safe same-origin `/dashboard...` path collapses to `/dashboard`.
 */

const C0_CONTROL_END = 0x1f;
const DEL = 0x7f;

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

export function normalizeDashboardReturnTo(input: string | null | undefined): string {
  if (typeof input !== "string" || !input) {
    return "/dashboard";
  }
  if (!input.startsWith("/dashboard")) {
    return "/dashboard";
  }
  if (input.startsWith("//")) {
    return "/dashboard";
  }
  if (input.includes("\\")) {
    return "/dashboard";
  }
  if (containsControlChar(input)) {
    return "/dashboard";
  }
  return input;
}
