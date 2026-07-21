// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scrub rules specific to Reddit fixtures. Applied AFTER the shared
 * defaults in src/scrub-defaults.ts. Order within this file matters —
 * earlier rules win when a span matches multiple patterns.
 *
 * What's risky in a Reddit fixture:
 *   - Usernames (u/<name>, /u/<name>, /user/<name>) — appear in
 *     permalinks, link_ids (sometimes), and free-form text.
 *   - Real-person names inside free-form post/comment bodies.
 *     The deterministic scrubber can't safely catch these;
 *     rely on LLM redaction plans for that layer (see §9.1 of
 *     connector-authoring-guide).
 *   - Subreddit names identify the owner's interests. Not PII on
 *     their own, but the mosaic is identifying — leave them alone
 *     unless a specific sub is a bad idea to commit.
 *   - External URLs: potentially linked personal sites. We preserve
 *     domain for analysis utility; if a specific URL is sensitive,
 *     add a one-off rule below.
 *
 * Authored fullnames (t3_* and t1_* prefixes) stay as-is — they're
 * stable public IDs, not sensitive.
 */

import type { ScrubRule } from "../../src/scrubber.ts";

// Module-scoped regex (biome useTopLevelRegex).
const USER_MENTION_RE = /\b(?:\/?u\/|\/user\/)([A-Za-z0-9][A-Za-z0-9_-]{1,19})\b/g;

export const scrubRules: readonly ScrubRule[] = [
  // /u/name, u/name, /user/name → /u/[REDACTED_USER]. Matches Reddit's
  // 3-20 character username rule (starts alphanumeric, then
  // alphanumeric/underscore/hyphen).
  {
    pattern: USER_MENTION_RE,
    replacement: "/u/[REDACTED_USER]",
    scope: "all",
  },
];
