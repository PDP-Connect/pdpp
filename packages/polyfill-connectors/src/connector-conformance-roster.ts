/**
 * Hand-maintained roster of production-ready connectors — every connector
 * this repo lists as owner-selectable (`capabilities.public_listing.listed
 * === true`) and expects to actually collect data, not scaffold a
 * `SKIP_RESULT` placeholder.
 *
 * This is executable data, not documentation, and one of FOUR disjoint,
 * exhaustive roster categories `connector-conformance.test.ts` checks every
 * manifest connector key against (the others are `REAL_UNLISTED_CONNECTORS`,
 * `KNOWN_SCAFFOLD_CONNECTORS` below, and the manifest-derived
 * `DEPRECATED_UPSTREAM_STATUS` set) — every connector key MUST land in
 * exactly one, closing the prior gap where `public_listing.listed: false`
 * silently opted a connector out of every conformance check. Category
 * transitions (e.g. a scaffold proving real collection, or a real-unlisted
 * connector shipping `listed: true`) are deliberate roster edits, not
 * automatically inferred from source shape.
 *
 * `connector-conformance.test.ts` cross-checks this roster:
 *   1. its connector set matches exactly which manifests declare
 *      `public_listing.listed === true` (a listed connector missing from the
 *      roster, or a roster entry no longer listed, fails CI);
 *   2. every roster entry's `testFile` exists on disk;
 *   3. its connector set is disjoint from `KNOWN_SCAFFOLD_CONNECTORS`
 *      (anthropic, doordash, linkedin, loom, meta, shopify, uber,
 *      wholefoods) — all of which are `listed: false` today and MUST stay
 *      that way until they actually collect.
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
  heb: { testFile: "connectors/heb/index.test.ts" },
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
 * test file, but not (yet) owner-selectable — `public_listing.listed` is
 * `false`/absent, typically `status: "unproven"` pending an operator proving
 * a live run. This is a DIFFERENT axis from `PRODUCTION_READY_CONNECTORS`:
 * listing is a product/rollout decision, not a proxy for "has real code."
 * Conflating the two would either force an unlisted-but-real connector into
 * the listing-bound roster (wrong — it says nothing about whether the
 * connector should be owner-selectable) or leave it invisible to the
 * exhaustiveness check in `connector-conformance.test.ts` (the gap this
 * bucket closes). Promote an entry to `PRODUCTION_READY_CONNECTORS` when its
 * manifest flips to `listed: true`; the conformance test enforces that the
 * two rosters stay disjoint the same way scaffolds do.
 */
export const REAL_UNLISTED_CONNECTORS: Record<string, { testFile: string }> = {
  apple_health: { testFile: "connectors/apple_health/parsers.test.ts" },
  google_takeout: { testFile: "connectors/google_takeout/schemas.test.ts" },
  ical: { testFile: "connectors/ical/parsers.test.ts" },
  imessage: { testFile: "connectors/imessage/integration.test.ts" },
  spotify: { testFile: "connectors/spotify/schemas.test.ts" },
  twitter_archive: { testFile: "connectors/twitter_archive/parsers.test.ts" },
};

/**
 * Connectors whose manifest declares `public_listing.status ===
 * "deprecated_upstream"` — the upstream source no longer exists (e.g. Pocket,
 * shut down by Mozilla 2026-07-08), so the connector has real code but can
 * never collect again and will never be listed. This set is derived from the
 * manifest field at test time (see `connector-conformance.test.ts`), not
 * hand-maintained, so a future connector reaching this terminal state is
 * absorbed automatically without a roster edit — unlike the other three
 * buckets, which are asserting a manual claim against the manifest, this one
 * IS the manifest's own claim.
 */
export const DEPRECATED_UPSTREAM_STATUS = "deprecated_upstream";
