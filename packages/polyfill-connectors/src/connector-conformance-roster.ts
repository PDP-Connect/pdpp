// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-maintained roster of real owner-visible connectors: every Supported
 * or Preview manifest that is expected to collect data rather than emit an
 * unconditional `SKIP_RESULT` placeholder.
 *
 * This is executable data, not documentation, and one of three disjoint,
 * exhaustive roster categories `connector-conformance.test.ts` checks every
 * manifest connector key against (the others are `REAL_UNLISTED_CONNECTORS`,
 * `KNOWN_SCAFFOLD_CONNECTORS` below). Every connector key MUST land in
 * exactly one. Category transitions are deliberate roster edits.
 *
 * `connector-conformance.test.ts` cross-checks this roster:
 *   1. its connector set matches exactly which manifests declare Supported
 *      or Preview (a visible connector missing from the roster fails CI);
 *   2. every roster entry's `testFile` exists on disk;
 *   3. its connector set is disjoint from `KNOWN_SCAFFOLD_CONNECTORS`
 *      (anthropic, doordash, linkedin, loom, meta, shopify, uber,
 *      wholefoods) — all of which MUST remain Development until they collect.
 *
 * `testFile` names each connector's own named collection/integration test —
 * the behavioral oracle for whether it really collects real data. This
 * roster does not re-run or re-prove that oracle; it only asserts the oracle
 * exists and that lifecycle tier hasn't drifted from it. Each connector's own
 * suite remains authoritative for its collection behavior.
 */
export const PRODUCTION_READY_CONNECTORS: Record<string, { testFile: string }> = {
  amazon: { testFile: "connectors/amazon/integration.test.ts" },
  apple_contacts: { testFile: "connectors/apple_contacts/integration.test.ts" },
  chase: { testFile: "connectors/chase/integration.test.ts" },
  chatgpt: { testFile: "connectors/chatgpt/integration.test.ts" },
  claude_code: { testFile: "connectors/claude_code/integration.test.ts" },
  codex: { testFile: "connectors/codex/integration.test.ts" },
  github: { testFile: "connectors/github/parsers.test.ts" },
  gmail: { testFile: "connectors/gmail/integration.test.ts" },
  groupme: { testFile: "connectors/groupme/collection.test.ts" },
  heb: { testFile: "connectors/heb/index.test.ts" },
  google_maps: { testFile: "connectors/google_maps/parsers.test.ts" },
  jellyfin: { testFile: "connectors/jellyfin/protocol-subprocess.test.ts" },
  notion: { testFile: "connectors/notion/schemas.test.ts" },
  reddit: { testFile: "connectors/reddit/integration.test.ts" },
  slack: { testFile: "connectors/slack/integration.test.ts" },
  steam: { testFile: "connectors/steam/index.test.ts" },
  usaa: { testFile: "connectors/usaa/integration.test.ts" },
  whatsapp: { testFile: "connectors/whatsapp/integration.test.ts" },
  whoop: { testFile: "connectors/whoop/integration.test.ts" },
  ynab: { testFile: "connectors/ynab/integration.test.ts" },
};
/**
 * Connectors that are scaffolded (unconditional `SKIP_RESULT`, no real
 * collection) and MUST stay outside `PRODUCTION_READY_CONNECTORS` and outside
 * the owner-selectable listing until they actually collect.
 */
export const KNOWN_SCAFFOLD_CONNECTORS = [
  "anthropic",
  "doordash",
  "linkedin",
  "loom",
  "meta",
  "shopify",
  "uber",
  "wholefoods",
] as const;

/**
 * Connectors with a REAL collector (verified: no unconditional `SKIP_RESULT`
 * stub, genuine parsing/pagination/cursor logic) and a real behavioral-oracle
 * test file, but whose lifecycle tier is Development. This is distinct from
 * a scaffold: real parsing or collection code exists, but live evidence does
 * not yet justify offering it. Promote an entry when its tier becomes Preview
 * or Supported; the conformance test keeps the rosters disjoint.
 */
export const REAL_UNLISTED_CONNECTORS: Record<string, { testFile: string }> = {
  apple_health: { testFile: "connectors/apple_health/parsers.test.ts" },
  apple_photos: { testFile: "connectors/apple_photos/integration.test.ts" },
  google_calendar: { testFile: "connectors/google_calendar/index.test.ts" },
  google_contacts: { testFile: "connectors/google_contacts/index.test.ts" },
  google_maps_data_portability: { testFile: "connectors/google_maps_data_portability/api.test.ts" },
  google_messages: { testFile: "connectors/google_messages/integration.test.ts" },
  google_takeout: { testFile: "connectors/google_takeout/schemas.test.ts" },
  // Import-only (CSV/zip upload); no collection path is implemented. Real,
  // not scaffold: it parses a
  // genuine Netflix export rather than emitting a SKIP_RESULT placeholder.
  netflix_export: { testFile: "connectors/netflix_export/integration.test.ts" },
  oura: { testFile: "connectors/oura/schemas.test.ts" },
  ical: { testFile: "connectors/ical/parsers.test.ts" },
  imessage: { testFile: "connectors/imessage/integration.test.ts" },
  pocket: { testFile: "connectors/pocket/schemas.test.ts" },
  spotify: { testFile: "connectors/spotify/schemas.test.ts" },
  strava: { testFile: "connectors/strava/schemas.test.ts" },
  twitter_archive: { testFile: "connectors/twitter_archive/parsers.test.ts" },
  venmo: { testFile: "connectors/venmo/integration.test.ts" },
};
