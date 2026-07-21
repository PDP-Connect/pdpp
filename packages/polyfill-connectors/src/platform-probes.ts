// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BrowserContext, Page } from "playwright";

/** Minimal structural type that detectCloudflareChallenge requires from a page. */
export interface CloudflarePage {
  locator(selector: string): { count(): Promise<number> };
  title(): Promise<string>;
}

/** Minimal structural type that detectCloudflareChallenge requires from a navigation response. */
export interface CloudflareNavResponse {
  headers(): Record<string, string>;
  status(): number;
}

const AMAZON_SIGNIN_URL = /\/ap\/signin/i;
const AMAZON_SIGNIN_TITLE = /sign[- ]in/i;
const USAA_SESSION_COOKIE = /^(LtpaToken2|AST|MemberGlobalSession)$/;
const CF_TITLE_RE = /^just a moment/i;
const CF_SERVER_RE = /cloudflare/i;

/**
 * Passive probes the bootstrap flow uses to detect whether a given platform's
 * session is live in the shared browser profile. Each probe opens its
 * `probeUrl` and calls `isLoggedIn(page, context)` — if that returns true,
 * the bootstrap UI marks it as ok and moves on.
 *
 * Keep probes read-only. Never submit forms, never navigate elsewhere mid-
 * probe. The connectors themselves (not this file) do the real auth work.
 */

export interface PlatformProbe {
  bootstrapUrl: string;
  isLoggedIn: (page: Page, context: BrowserContext) => Promise<boolean>;
  label: string;
  probeUrl: string;
}

/**
 * A single observed Cloudflare-challenge signal. Each is an independently
 * sufficient marker of a real Cloudflare interstitial / Turnstile challenge.
 */
export type CloudflareSignal =
  | "title_just_a_moment"
  | "cf_challenge_dom"
  | "challenge_platform_script"
  | "turnstile_iframe"
  | "cf_mitigated_header"
  | "http_403_cf";

export interface CloudflareVerdict {
  /** "confirmed" when isChallenge, else "none" — so callers never GUESS. */
  confidence: "confirmed" | "none";
  /** True iff at least one real Cloudflare-challenge signal was observed. */
  isChallenge: boolean;
  /** The specific signals that fired (for honest, legible diagnostics). */
  signals: CloudflareSignal[];
}

/**
 * Connector-AGNOSTIC detection of a Cloudflare bot challenge (the "Just a
 * moment…" interstitial / Turnstile "Verify you are human"). Browser connectors
 * (ChatGPT, Reddit, Amazon, …) all hit the same wall; before this, each GUESSED
 * "possibly Cloudflare challenge" purely from "expected login inputs not found"
 * — right by luck at best, and mislabeling ordinary UI drift at worst. This
 * earns the diagnosis from real artifacts so the operator-facing message,
 * interaction reason, and posture are honest.
 *
 * READ-ONLY by contract (matches this file's probe doctrine): it inspects title,
 * DOM, and the optional navigation response — it NEVER clicks, types, navigates,
 * or attempts to solve the Turnstile (auto-solving would risk the account and is
 * exactly the bot behavior the challenge exists to stop).
 *
 * Pass `opts.navResponse` (the Response from the goto/navigation that landed on
 * the suspect page) to additionally consult Cloudflare response headers/status.
 */
export async function detectCloudflareChallenge(
  page: CloudflarePage,
  opts: { navResponse?: CloudflareNavResponse | null } = {}
): Promise<CloudflareVerdict> {
  const signals: CloudflareSignal[] = [];

  // Every probe is best-effort: a missing/odd page method (synchronous throw) or
  // a rejected promise yields the fallback, never an exception out of detection.
  // Detection must NEVER be the thing that breaks a login flow.
  const safe = async <T>(fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  const countMatches = (selector: string): Promise<number> => safe(() => page.locator(selector).count(), 0);

  const title = await safe(() => page.title(), "");
  if (CF_TITLE_RE.test(title)) {
    signals.push("title_just_a_moment");
  }

  // CF-specific scripts/iframes are unambiguous Cloudflare artifacts.
  if ((await countMatches('script[src*="challenge-platform"], script[src*="/cdn-cgi/challenge-platform/"]')) > 0) {
    signals.push("challenge_platform_script");
  }

  if ((await countMatches('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')) > 0) {
    signals.push("turnstile_iframe");
  }

  // DOM-id arm. The canonical challenge containers are specific; the loose
  // `[id^="cf-"]` prefix alone could match an unrelated app element, so it only
  // counts when corroborated by another CF-specific signal already observed.
  if ((await countMatches("#cf-challenge-running, #challenge-running, #cf-error-details")) > 0) {
    signals.push("cf_challenge_dom");
  } else if (signals.length > 0 && (await countMatches('[id^="cf-"]')) > 0) {
    signals.push("cf_challenge_dom");
  }

  const navResponse = opts.navResponse;
  if (navResponse) {
    const headers = navResponse.headers();
    if (headers["cf-mitigated"] === "challenge") {
      signals.push("cf_mitigated_header");
    }
    const server = headers.server ?? "";
    if (navResponse.status() === 403 && (headers["cf-ray"] != null || CF_SERVER_RE.test(server))) {
      signals.push("http_403_cf");
    }
  }

  const isChallenge = signals.length > 0;
  return { isChallenge, signals, confidence: isChallenge ? "confirmed" : "none" };
}

interface ChatGptSession {
  user?: { id?: string };
}

export const PLATFORMS: Record<string, PlatformProbe> = {
  amazon: {
    label: "Amazon",
    bootstrapUrl: "https://www.amazon.com/gp/sign-in.html",
    probeUrl: "https://www.amazon.com/gp/your-account/order-history",
    async isLoggedIn(page): Promise<boolean> {
      const url = page.url();
      if (AMAZON_SIGNIN_URL.test(url)) {
        return false;
      }
      const hasOrderHistory = await page
        .locator("h1, #navFooter, .your-orders-page")
        .first()
        .isVisible()
        .catch(() => false);
      const title = await page.title().catch(() => "");
      return hasOrderHistory && !AMAZON_SIGNIN_TITLE.test(title);
    },
  },
  chatgpt: {
    label: "ChatGPT",
    bootstrapUrl: "https://chatgpt.com/",
    probeUrl: "https://chatgpt.com/api/auth/session",
    async isLoggedIn(page): Promise<boolean> {
      try {
        const body = (await page.evaluate(async (): Promise<ChatGptSession | null> => {
          const r = await fetch("/api/auth/session", {
            credentials: "include",
          });
          if (!r.ok) {
            return null;
          }
          return r.json() as Promise<ChatGptSession>;
        })) as ChatGptSession | null;
        return Boolean(body?.user);
      } catch {
        return false;
      }
    },
  },
  usaa: {
    label: "USAA",
    bootstrapUrl: "https://www.usaa.com/inet/wc/logon",
    probeUrl: "https://www.usaa.com/",
    async isLoggedIn(_page, context): Promise<boolean> {
      // Cookie-based probe: USAA sets UsaaMbWebMemberLoggedIn only when
      // authenticated. Resilient to URL reorganizations that would break
      // path-based probes.
      try {
        const cookies = await context.cookies("https://www.usaa.com/");
        const loggedInCookie = cookies.find((c) => c.name === "UsaaMbWebMemberLoggedIn");
        if (loggedInCookie?.value && loggedInCookie.value !== "false") {
          return true;
        }
        return cookies.some((c) => USAA_SESSION_COOKIE.test(c.name));
      } catch {
        return false;
      }
    },
  },
};
