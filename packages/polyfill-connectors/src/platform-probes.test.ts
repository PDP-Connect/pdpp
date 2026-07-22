// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for detectCloudflareChallenge (platform-probes.ts).
 *
 * Each test builds a minimal fake page / navResponse that exercises exactly
 * the branch under test, verifying oracle-level assertions against the real
 * implementation.  No network, no browser process.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudflareNavResponse, CloudflarePage, CloudflareSignal } from "./platform-probes.ts";
import { detectCloudflareChallenge } from "./platform-probes.ts";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Page.  `title` is what page.title() resolves to.
 * `selectorCounts` is a map from a substring → count returned whenever a
 * selector contains that substring; the first matching entry wins.
 * Pass `throwAll: true` to make every method throw synchronously (defensive
 * test).
 */
function fakePage(opts: {
  title?: string;
  selectorCounts?: Record<string, number>;
  throwAll?: boolean;
}): CloudflarePage {
  const { title = "ChatGPT", selectorCounts = {}, throwAll = false } = opts;

  return {
    title(): Promise<string> {
      if (throwAll) {
        throw new Error("title() exploded");
      }
      return Promise.resolve(title);
    },
    locator(selector: string) {
      if (throwAll) {
        throw new Error("locator() exploded");
      }
      // Find the first matching entry in selectorCounts whose key is a
      // substring of the selector string.
      const matchKey = Object.keys(selectorCounts).find((k) => selector.includes(k));
      const count = matchKey === undefined ? 0 : (selectorCounts[matchKey] ?? 0);
      return {
        count(): Promise<number> {
          return Promise.resolve(count);
        },
      };
    },
  };
}

/**
 * Build a minimal fake Response.  `headers` is the raw header map;
 * `status` is the HTTP status code.
 */
function fakeNavResponse(opts: { headers?: Record<string, string>; status?: number }): CloudflareNavResponse {
  const { headers = {}, status = 200 } = opts;
  return {
    headers(): Record<string, string> {
      return headers;
    },
    status(): number {
      return status;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectCloudflareChallenge", () => {
  // 1. Title arm ─────────────────────────────────────────────────────────────
  it("title_just_a_moment: 'Just a moment...' triggers isChallenge confirmed", async () => {
    const page = fakePage({ title: "Just a moment..." });
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(verdict.isChallenge, true);
    assert.equal(verdict.confidence, "confirmed");
    assert.ok(
      verdict.signals.includes("title_just_a_moment"),
      `expected title_just_a_moment in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 2. Challenge-platform script ─────────────────────────────────────────────
  it("challenge_platform_script: locator for challenge-platform script > 0 fires signal", async () => {
    // The selector is: script[src*="challenge-platform"], script[src*="/cdn-cgi/challenge-platform/"]
    // Both contain the substring "challenge-platform".
    const page = fakePage({ selectorCounts: { "challenge-platform": 1 } });
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(verdict.isChallenge, true);
    assert.ok(
      verdict.signals.includes("challenge_platform_script"),
      `expected challenge_platform_script in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 3. Turnstile iframe ──────────────────────────────────────────────────────
  it("turnstile_iframe: locator for challenges.cloudflare.com iframe > 0 fires signal", async () => {
    // The selector contains "challenges.cloudflare.com" and "turnstile".
    const page = fakePage({ selectorCounts: { "challenges.cloudflare.com": 1 } });
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(verdict.isChallenge, true);
    assert.ok(
      verdict.signals.includes("turnstile_iframe"),
      `expected turnstile_iframe in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 4a. cf_mitigated_header ──────────────────────────────────────────────────
  it("cf_mitigated_header: cf-mitigated: challenge response header fires signal", async () => {
    const page = fakePage({});
    const navResponse = fakeNavResponse({ headers: { "cf-mitigated": "challenge" } });
    const verdict = await detectCloudflareChallenge(page, { navResponse });
    assert.equal(verdict.isChallenge, true);
    assert.ok(
      verdict.signals.includes("cf_mitigated_header"),
      `expected cf_mitigated_header in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 4b. http_403_cf ──────────────────────────────────────────────────────────
  it("http_403_cf: 403 + cf-ray header fires signal", async () => {
    const page = fakePage({});
    const navResponse = fakeNavResponse({
      headers: { "cf-ray": "abc123-SFO" },
      status: 403,
    });
    const verdict = await detectCloudflareChallenge(page, { navResponse });
    assert.equal(verdict.isChallenge, true);
    assert.ok(
      verdict.signals.includes("http_403_cf"),
      `expected http_403_cf in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 5a. cf_challenge_dom — loose [id^="cf-"] alone does NOT add signal ───────
  it('cf_challenge_dom NOT added: loose [id^="cf-"] alone (no other signal)', async () => {
    // Only the loose `[id^="cf-"]` selector matches; no other signal fires.
    // The corroboration guard says: only push cf_challenge_dom via the
    // [id^="cf-"] path when signals.length > 0 at that point.
    const page = fakePage({
      selectorCounts: {
        // Make the specific ids return 0 (default), but [id^="cf-"] return 1.
        // We key on exact substring used in the loose-arm selector.
        '[id^="cf-"]': 1,
        "#cf-challenge-running": 0,
        "challenge-running": 0,
        "cf-error-details": 0,
        "challenge-platform": 0,
        "challenges.cloudflare.com": 0,
        turnstile: 0,
      },
    });
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(
      verdict.signals.includes("cf_challenge_dom"),
      false,
      `cf_challenge_dom must NOT appear when it is the only signal candidate; got: ${verdict.signals.join(", ")}`
    );
  });

  // 5b. cf_challenge_dom — loose [id^="cf-"] WITH another signal → does add it
  it('cf_challenge_dom IS added: [id^="cf-"] corroborated by title signal', async () => {
    // Title fires first → signals.length>0 before the DOM-id arm runs.
    const page = fakePage({
      title: "Just a moment...",
      selectorCounts: {
        '[id^="cf-"]': 1,
        "#cf-challenge-running": 0,
        "challenge-running": 0,
        "cf-error-details": 0,
        "challenge-platform": 0,
        "challenges.cloudflare.com": 0,
        turnstile: 0,
      },
    });
    const verdict = await detectCloudflareChallenge(page);
    assert.ok(
      verdict.signals.includes("cf_challenge_dom"),
      `expected cf_challenge_dom when corroborated by title; got: ${verdict.signals.join(", ")}`
    );
    assert.ok(verdict.signals.includes("title_just_a_moment"));
  });

  // 6. Clean page ─────────────────────────────────────────────────────────────
  it("clean page: no challenge signals → isChallenge:false, empty signals, confidence:none", async () => {
    const page = fakePage({ title: "ChatGPT" });
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(verdict.isChallenge, false);
    assert.equal(verdict.confidence, "none");
    assert.deepEqual(verdict.signals as CloudflareSignal[], [] as CloudflareSignal[]);
  });

  // 7. Defensive: throwing page → returns safe zero-verdict, never throws ────
  it("defensive: page that throws synchronously on every method → safe zero-verdict", async () => {
    const page = fakePage({ throwAll: true });
    // Must not throw — the safe() wrapper inside detectCloudflareChallenge
    // must swallow every error.
    const verdict = await detectCloudflareChallenge(page);
    assert.equal(verdict.isChallenge, false);
    assert.equal(verdict.confidence, "none");
    assert.deepEqual(verdict.signals as CloudflareSignal[], [] as CloudflareSignal[]);
  });
});
