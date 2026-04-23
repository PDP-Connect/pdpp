import type { BrowserContext, Page } from "playwright";

const AMAZON_SIGNIN_URL = /\/ap\/signin/i;
const AMAZON_SIGNIN_TITLE = /sign[- ]in/i;
const USAA_SESSION_COOKIE = /^(LtpaToken2|AST|MemberGlobalSession)$/;

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
