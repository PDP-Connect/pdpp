// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for detectCloudflareChallenge and detectProviderBlockInterstitial
 * (platform-probes.ts).
 *
 * Each test builds a minimal fake page / navResponse that exercises exactly
 * the branch under test, verifying oracle-level assertions against the real
 * implementation.  No network, no browser process.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BlockInterstitialPage,
  BlockInterstitialSignal,
  CloudflareNavResponse,
  CloudflarePage,
  CloudflareSignal,
} from "./platform-probes.ts";
import { detectCloudflareChallenge, detectProviderBlockInterstitial } from "./platform-probes.ts";

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

// ---------------------------------------------------------------------------
// detectProviderBlockInterstitial
// ---------------------------------------------------------------------------
//
// Regression coverage for the "evidence collected but claim mislabeled"
// defect: a browser connector hit a real provider block/bot-mitigation page
// that was NOT Cloudflare (detectCloudflareChallenge correctly found no
// Cloudflare signals), and the CLI printed a generic "page may have changed"
// message instead of naming what the captured page actually showed. Two real
// observations motivate the two positive cases below:
//   - heb: https://www.heb.com/my-account/your-orders returned an
//     Imperva/Incapsula bot-mitigation page — a raw JSON body with
//     errorCode: "15" plus incident/proxy IDs — instead of a login form.
//   - reddit: the login page served Reddit's own "You've been blocked by
//     network security" interstitial (not Cloudflare).

/** Build a minimal fake BlockInterstitialPage. `title`/`content` resolve to
 *  the given strings; `throwAll: true` makes every method throw
 *  synchronously (defensive test, mirrors fakePage's throwAll). */
function fakeBlockPage(opts: { content?: string; throwAll?: boolean; title?: string }): BlockInterstitialPage {
  const { content = "", throwAll = false, title = "" } = opts;
  return {
    content(): Promise<string> {
      if (throwAll) {
        throw new Error("content() exploded");
      }
      return Promise.resolve(content);
    },
    title(): Promise<string> {
      if (throwAll) {
        throw new Error("title() exploded");
      }
      return Promise.resolve(title);
    },
  };
}

describe("detectProviderBlockInterstitial", () => {
  // 1. Imperva/Incapsula JSON block body (the heb observation) ──────────────
  it("imperva_incapsula_json_error: Imperva JSON block body (errorCode + incidentId) fires signal", async () => {
    // Playwright's page.content() wraps a raw JSON response in a synthetic
    // <html><body><pre>...</pre></body></html> shell, matching real-browser
    // rendering of a non-HTML response — the JSON text still appears
    // verbatim in content(). This is the exact shape observed on the live
    // heb run: a bare error payload, no HTML challenge widget, no iframe.
    const content =
      '<html><head></head><body><pre>{"errorCode":"15","errorDescription":"Incapsula incident ID: 123456789012345678-987654321098765432","incidentId":"123456789012345678-987654321098765432","proxyId":"abcdef12"}</pre></body></html>';
    const page = fakeBlockPage({ content });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.equal(verdict.isBlocked, true);
    assert.equal(verdict.confidence, "confirmed");
    assert.ok(
      verdict.signals.includes("imperva_incapsula_json_error"),
      `expected imperva_incapsula_json_error in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  it("imperva_incapsula_json_error: errorCode alone (no incident/proxy id) does NOT fire — avoids false positive on unrelated API error bodies", async () => {
    const content = '<html><body><pre>{"errorCode":"42","message":"not found"}</pre></body></html>';
    const page = fakeBlockPage({ content });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.equal(
      verdict.signals.includes("imperva_incapsula_json_error"),
      false,
      `errorCode alone must not fire the Imperva signal; got: ${verdict.signals.join(", ")}`
    );
  });

  // 2. Reddit-style "blocked by network security" interstitial ──────────────
  it('network_security_block_heading: "You\'ve been blocked by network security" title fires signal', async () => {
    const page = fakeBlockPage({ title: "You've been blocked by network security" });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.equal(verdict.isBlocked, true);
    assert.equal(verdict.confidence, "confirmed");
    assert.ok(
      verdict.signals.includes("network_security_block_heading"),
      `expected network_security_block_heading in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  it("network_security_block_heading: also fires from body content, not just title", async () => {
    const page = fakeBlockPage({
      content: "<html><body><h1>You've been blocked by network security</h1></body></html>",
    });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.ok(
      verdict.signals.includes("network_security_block_heading"),
      `expected network_security_block_heading in signals, got: ${verdict.signals.join(", ")}`
    );
  });

  // 3. NEGATIVE control: an ordinary login page must NOT classify as blocked ─
  it("negative control: an ordinary login page is NOT classified as blocked", async () => {
    const page = fakeBlockPage({
      title: "Log in to Reddit",
      content:
        '<html><body><form><input name="username"/><input name="password" type="password"/><button type="submit">Log In</button></form></body></html>',
    });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.equal(verdict.isBlocked, false);
    assert.equal(verdict.confidence, "none");
    assert.deepEqual(verdict.signals as BlockInterstitialSignal[], [] as BlockInterstitialSignal[]);
  });

  // 4. A Cloudflare page still classifies as Cloudflare via the OTHER
  //    detector, not as this one — the two detectors are disjoint by design.
  it("a Cloudflare 'Just a moment...' page does NOT fire this detector's signals (stays Cloudflare's territory)", async () => {
    const cfPage: CloudflarePage = {
      title(): Promise<string> {
        return Promise.resolve("Just a moment...");
      },
      locator(): { count: () => Promise<number> } {
        return { count: (): Promise<number> => Promise.resolve(0) };
      },
    };
    const cfVerdict = await detectCloudflareChallenge(cfPage);
    assert.equal(cfVerdict.isChallenge, true);
    assert.ok(cfVerdict.signals.includes("title_just_a_moment"));

    const blockPage = fakeBlockPage({
      title: "Just a moment...",
      content: '<html><body><div id="cf-challenge-running"></div></body></html>',
    });
    const blockVerdict = await detectProviderBlockInterstitial(blockPage);
    assert.equal(blockVerdict.isBlocked, false);
    assert.deepEqual(blockVerdict.signals as BlockInterstitialSignal[], [] as BlockInterstitialSignal[]);
  });

  // 5. Defensive: throwing page → returns safe zero-verdict, never throws ───
  it("defensive: page that throws synchronously on every method → safe zero-verdict", async () => {
    const page = fakeBlockPage({ throwAll: true });
    const verdict = await detectProviderBlockInterstitial(page);
    assert.equal(verdict.isBlocked, false);
    assert.equal(verdict.confidence, "none");
    assert.deepEqual(verdict.signals as BlockInterstitialSignal[], [] as BlockInterstitialSignal[]);
  });
});
