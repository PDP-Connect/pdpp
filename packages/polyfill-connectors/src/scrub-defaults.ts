// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import type { ScrubRule } from "./scrubber.ts";

const ACCOUNT_FIELD_REPLACEMENT = "$1$2[REDACTED_ACCOUNT]$4";
const NAME_FIELD_REPLACEMENT = "$1$2[REDACTED_NAME]$4";

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
    pattern: /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3})\b/g,
    replacement: "0000-0000-0000-0000",
    scope: "all",
  },
  // US phone numbers — permissive pattern covering (xxx) xxx-xxxx,
  // xxx-xxx-xxxx, +1 xxx xxx xxxx, etc.
  {
    pattern: /(?<![\d-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?![\d-])/g,
    replacement: "555-555-5555",
    scope: "all",
  },
  // Bank/card account identifiers when the surrounding label makes the
  // semantics deterministic. This avoids rewriting arbitrary quantities.
  {
    pattern:
      /(\b(?:account|acct|routing|member|customer|user)\s*(?:number|no\.?|#|id)?\s*[:=]\s*)(["']?)([A-Za-z0-9][A-Za-z0-9 -]{4,34})(["']?)/gi,
    replacement: ACCOUNT_FIELD_REPLACEMENT,
    scope: "all",
  },
  // JSON object keys commonly used for account-like identifiers.
  {
    pattern:
      /("(?:accountNumber|account_number|routingNumber|routing_number|cardNumber|card_number|memberId|member_id|customerId|customer_id|userId|user_id)"\s*:\s*")([^"]+)(")/g,
    replacement: "$1[REDACTED_ACCOUNT]$3",
    scope: "json",
  },
  // US street addresses. Preserve surrounding markup/JSON but replace the
  // street line itself; city/state/ZIP often leak enough to identify a person.
  {
    pattern:
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Apartment|Avenue|Boulevard|Circle|Court|Drive|Lane|Parkway|Place|Road|Street|Suite|Unit|Apt|Ave|Blvd|Cir|Ct|Dr|Ln|Pkwy|Pl|Rd|St|Way)\.?(?:\s+(?:Apartment|Suite|Unit|Apt|#)\s*[A-Za-z0-9-]+)?(?:,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g,
    replacement: "[REDACTED_ADDRESS]",
    scope: "all",
  },
  // Names only when keyed/labeled as names. Broad free-text name detection is
  // intentionally left to future semantic review because false positives can
  // erase parser-relevant content.
  {
    pattern:
      /(\b(?:full\s*name|customer\s*name|cardholder\s*name|recipient\s*name|ship\s*to|bill\s*to|name)\s*[:=]\s*)(["']?)([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})(["']?)/gi,
    replacement: NAME_FIELD_REPLACEMENT,
    scope: "all",
  },
  {
    pattern:
      /("(?:name|fullName|full_name|customerName|customer_name|cardholderName|cardholder_name|recipientName|recipient_name|shipTo|ship_to|billTo|bill_to)"\s*:\s*")([^"]+)(")/g,
    replacement: "$1[REDACTED_NAME]$3",
    scope: "json",
  },
];
