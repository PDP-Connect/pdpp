/**
 * Shared scrub rules every connector inherits. PII patterns that are
 * universally unsafe to commit, regardless of source platform.
 *
 * Connector-specific rules live in `connectors/<name>/scrub-rules.ts`
 * and are applied AFTER defaults. Order matters: earlier rules that
 * catch a PII shape should precede broader fallbacks.
 *
 * This list is intentionally conservative — false positives are harmless
 * (replacing non-PII), but false negatives leak user data. When in doubt,
 * add a rule here rather than leaving it for per-connector authors.
 */

/** Which captured file type a rule applies to. */
export type ScrubScope = "all" | "html" | "json";

/** A single scrub rule. `replacement` may be a string or a replacer function. */
export interface ScrubRule {
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: unknown[]) => string);
  scope: ScrubScope;
}

export const defaultScrubRules: readonly ScrubRule[] = [
  // Email addresses (RFC 5322 simplified — good enough for scrubbing).
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "redacted@example.com",
    scope: "all",
  },
  // US SSN (xxx-xx-xxxx). Keep format but zero the digits.
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "000-00-0000",
    scope: "all",
  },
  // Credit-card-like numeric runs (13-19 digits, optionally with spaces/dashes).
  // Luhn-validating would be nicer; this is a conservative pre-filter.
  {
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: "0000-0000-0000-0000",
    scope: "all",
  },
  // US phone numbers — permissive pattern covering (xxx) xxx-xxxx,
  // xxx-xxx-xxxx, +1 xxx xxx xxxx, etc.
  {
    pattern: /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g,
    replacement: "555-555-5555",
    scope: "all",
  },
];
