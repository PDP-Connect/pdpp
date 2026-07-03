import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "./next.config.mjs";

/**
 * Clean owner-route topology redirect proof
 * (redesign-owner-console-product-experience §10.B).
 *
 * The console serves owner sections as clean top-level nouns off root; every
 * legacy `/dashboard/*` link must redirect to its clean target so bookmarks and
 * agent-generated links keep working. These tests resolve real request paths
 * against the actual `next.config.mjs` redirect table using Next.js first-match
 * semantics for the two pattern shapes the table uses:
 *   - exact string sources (`/dashboard`, `/dashboard/records`), and
 *   - `:rest*` prefix sources (`/dashboard/records/:rest*`), optionally with a
 *     named param carrying an inline regex (the bare-connector rule).
 *
 * It deliberately does not depend on Next's private path-to-regexp build; it
 * models the subset of matching the table relies on, and a sabotage probe at
 * the end proves the matcher is not vacuously passing.
 */

const redirects = await nextConfig.redirects();

/**
 * Try to match one redirect rule against a pathname. Returns the resolved
 * destination (with `:rest*` / named params substituted) or null.
 *
 * Supported source shapes:
 *   - `/exact/path`                          → exact match
 *   - `/prefix/:rest*`                       → matches `/prefix` + `/...tail`
 *   - `/prefix/:name(<regex>)/:rest*`        → one segment captured as `:name`
 *                                              (validated against `<regex>`),
 *                                              then `/...tail` as `:rest*`
 */
function matchRule(rule, pathname) {
  const { source, destination } = rule;

  // Bare-connector rule: `/dashboard/:connector((?!...)[^/]+)/:rest*`.
  const connectorMatch = source.match(/^(\/dashboard)\/:connector\((.*)\)\/:rest\*$/);
  if (connectorMatch) {
    const [, prefix, inlineRe] = connectorMatch;
    if (!pathname.startsWith(`${prefix}/`)) {
      return null;
    }
    const afterPrefix = pathname.slice(prefix.length + 1);
    const firstSlash = afterPrefix.indexOf("/");
    const connector = firstSlash === -1 ? afterPrefix : afterPrefix.slice(0, firstSlash);
    const rest = firstSlash === -1 ? "" : afterPrefix.slice(firstSlash + 1);
    if (connector === "") {
      return null;
    }
    // The inline regex is a negative-lookahead reserved-section guard.
    if (!new RegExp(`^${inlineRe}$`).test(connector)) {
      return null;
    }
    return destination.replace(":connector", connector).replace(":rest*", rest).replace(/\/$/, "") || "/";
  }

  // `:rest*` prefix rule.
  if (source.endsWith("/:rest*")) {
    const prefix = source.slice(0, -"/:rest*".length);
    if (pathname === prefix) {
      return destination.replace("/:rest*", "").replace(":rest*", "") || "/";
    }
    if (pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length + 1);
      const out = destination.replace(":rest*", rest);
      return out.replace(/\/$/, "") || "/";
    }
    return null;
  }

  // Exact source.
  return pathname === source ? destination : null;
}

/** First-match resolution, mirroring Next.js redirect ordering. */
function resolve(pathname) {
  for (const rule of redirects) {
    const dest = matchRule(rule, pathname);
    if (dest !== null) {
      return { destination: dest, permanent: rule.permanent === true };
    }
  }
  return null;
}

// Every legacy owner path → its clean target. This is the durable contract.
const LEGACY_TO_CLEAN = [
  ["/dashboard", "/"],
  ["/dashboard/records", "/sources"],
  ["/dashboard/records/gmail", "/sources/gmail"],
  ["/dashboard/records/gmail/messages", "/sources/gmail/messages"],
  ["/dashboard/records/gmail/messages/rec_123", "/sources/gmail/messages/rec_123"],
  ["/dashboard/records/gmail/messages/health", "/sources/gmail/messages/health"],
  ["/dashboard/records/add", "/sources/add"],
  ["/dashboard/records/deployment", "/sources/deployment"],
  ["/dashboard/records/schedules", "/sources/schedules"],
  ["/dashboard/records/stream-playground", "/sources/stream-playground"],
  ["/dashboard/runs", "/syncs"],
  ["/dashboard/runs/run_42", "/syncs/run_42"],
  ["/dashboard/runs/run_42/stream", "/syncs/run_42/stream"],
  ["/dashboard/traces", "/audit"],
  ["/dashboard/traces/trace_9", "/audit/trace_9"],
  ["/dashboard/explore", "/explore"],
  ["/dashboard/grants", "/grants"],
  ["/dashboard/grants/grant_1", "/grants/grant_1"],
  ["/dashboard/grants/packages", "/grants/packages"],
  ["/dashboard/connect", "/connect"],
  ["/dashboard/connect/browser-session/gmail", "/connect/browser-session/gmail"],
  ["/dashboard/schedules", "/schedules"],
  ["/dashboard/deployment", "/deployment"],
  ["/dashboard/deployment/tokens", "/deployment/tokens"],
  ["/dashboard/device-exporters", "/device-exporters"],
  ["/dashboard/event-subscriptions", "/event-subscriptions"],
  ["/dashboard/search", "/search"],
  ["/dashboard/stream-playground", "/stream-playground"],
  // Chained legacy aliases.
  ["/dashboard/records/explorer", "/explore"],
  ["/dashboard/records/timeline", "/explore"],
  ["/dashboard/data", "/sources"],
  ["/dashboard/data/gmail", "/sources/gmail"],
  ["/dashboard/timeline", "/explore"],
  ["/dashboard/timeline/anything", "/explore"],
];

for (const [legacy, clean] of LEGACY_TO_CLEAN) {
  test(`legacy ${legacy} redirects to clean ${clean}`, () => {
    const result = resolve(legacy);
    assert.ok(result, `${legacy} must match a redirect rule`);
    assert.equal(result.destination, clean, `${legacy} should redirect to ${clean}, got ${result.destination}`);
  });
}

test("every /dashboard/* redirect to a now-final target is permanent", () => {
  for (const [legacy] of LEGACY_TO_CLEAN) {
    const result = resolve(legacy);
    assert.ok(result, `${legacy} must resolve`);
    assert.equal(result.permanent, true, `${legacy} redirect must be permanent (308)`);
  }
});

test("the bare-connector rule maps into Sources, not the old Records subtree", () => {
  const result = resolve("/dashboard/gmail/some/deep/path");
  assert.ok(result, "bare connector path must resolve");
  assert.equal(result.destination, "/sources/gmail/some/deep/path");
});

test("reserved sections are not caught by the bare-connector rule", () => {
  // `/dashboard/grants` is a section, not a connector id — it must land on the
  // clean `/grants`, never `/sources/grants`.
  assert.equal(resolve("/dashboard/grants").destination, "/grants");
  assert.equal(resolve("/dashboard/explore").destination, "/explore");
});

test("no redirect points back into the legacy /dashboard prefix", () => {
  for (const rule of redirects) {
    assert.ok(
      !rule.destination.startsWith("/dashboard"),
      `redirect ${rule.source} → ${rule.destination} must not target the legacy /dashboard prefix`
    );
  }
});

test("sabotage probe: an unmapped path does not spuriously resolve", () => {
  // A path that is not an owner route and not a redirect source resolves to
  // null — proving the matcher is not vacuously matching everything.
  assert.equal(resolve("/totally-unrelated-path"), null);
});
