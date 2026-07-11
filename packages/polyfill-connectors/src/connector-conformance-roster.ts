/**
 * Hand-maintained roster of production-ready connectors — every connector
 * this repo lists as owner-selectable (`capabilities.public_listing.listed
 * === true`) and expects to actually collect data, not scaffold a
 * `SKIP_RESULT` placeholder.
 *
 * This is executable data, not documentation. `connector-conformance.test.ts`
 * cross-checks it three ways:
 *   1. the roster's connector set matches exactly which manifests declare
 *      `public_listing.listed === true` (a listed connector missing from the
 *      roster, or a roster entry no longer listed, fails CI);
 *   2. every roster entry's `testFile` exists on disk;
 *   3. the roster's connector set is disjoint from the known scaffold
 *      connectors (doordash, heb, linkedin, loom, meta, shopify, uber,
 *      wholefoods, anthropic) — all of which are `listed: false` today and
 *      MUST stay that way until they actually collect.
 *
 * `testFile` names each connector's own named collection/integration test —
 * the behavioral oracle for whether it really collects real data. This
 * roster does not re-run or re-prove that oracle; it only asserts the oracle
 * exists and that listing state hasn't drifted from it. Each connector's own
 * suite remains authoritative for its collection behavior.
 */
export const PRODUCTION_READY_CONNECTORS: Record<string, { testFile: string }> = {
  amazon: { testFile: "connectors/amazon/integration.test.ts" },
  chase: { testFile: "connectors/chase/integration.test.ts" },
  chatgpt: { testFile: "connectors/chatgpt/integration.test.ts" },
  claude_code: { testFile: "connectors/claude_code/integration.test.ts" },
  codex: { testFile: "connectors/codex/integration.test.ts" },
  github: { testFile: "connectors/github/parsers.test.ts" },
  gmail: { testFile: "connectors/gmail/integration.test.ts" },
  google_maps: { testFile: "connectors/google_maps/parsers.test.ts" },
  google_maps_data_portability: { testFile: "connectors/google_maps_data_portability/api.test.ts" },
  notion: { testFile: "connectors/notion/schemas.test.ts" },
  oura: { testFile: "connectors/oura/schemas.test.ts" },
  reddit: { testFile: "connectors/reddit/integration.test.ts" },
  slack: { testFile: "connectors/slack/integration.test.ts" },
  strava: { testFile: "connectors/strava/schemas.test.ts" },
  usaa: { testFile: "connectors/usaa/integration.test.ts" },
  whatsapp: { testFile: "connectors/whatsapp/integration.test.ts" },
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
  "heb",
  "linkedin",
  "loom",
  "meta",
  "shopify",
  "uber",
  "wholefoods",
] as const;
