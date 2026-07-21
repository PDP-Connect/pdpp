// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { chromium } from "patchright";

/** An `Error` carrying a stable machine `code`. */
type CodedError = Error & { code?: string };

/** Matches the "binding already registered" errors that `exposeBinding` treats as idempotent no-ops. */
const BINDING_ALREADY_REGISTERED_RE = /binding .* already registered|already exists/i;

/**
 * Patchright's browser/context/page objects are duck-typed here: the client
 * probes for methods (`connectOverCDP`, `contexts`, `newPage`, …) so tests can
 * inject lightweight mocks in place of a real patchright driver. These loose
 * shapes preserve that contract without binding to the concrete driver types.
 */
// biome-ignore lint/suspicious/noExplicitAny: patchright driver is duck-typed here (see the block comment above); the client probes for methods rather than binding to concrete driver types.
type ChromiumImpl = any;
// biome-ignore lint/suspicious/noExplicitAny: duck-typed patchright browser handle.
type Browser = any;
// biome-ignore lint/suspicious/noExplicitAny: duck-typed patchright browser-context handle.
type BrowserContext = any;
// biome-ignore lint/suspicious/noExplicitAny: duck-typed patchright page handle.
type Page = any;

interface Viewport {
  height: number;
  width: number;
}

export interface NekoBrowserClient {
  addInitScript(source: unknown): Promise<void>;
  close(): Promise<void>;
  connect(): Promise<NekoBrowserClient>;
  evaluate(source: unknown): Promise<unknown>;
  exposeBinding(name: string, handler: unknown): Promise<void>;
  getPage(): Promise<Page>;
  goto(url: string): Promise<void>;
  keyboard: { insertText(text: string): Promise<void> };
  setViewportSize(viewport: Viewport): Promise<void>;
}

function assertCdpHttpUrl(cdpHttpUrl: unknown): asserts cdpHttpUrl is string {
  if (typeof cdpHttpUrl !== "string" || cdpHttpUrl.length === 0) {
    const err: CodedError = new Error("createNekoBrowserClient: cdpHttpUrl is required");
    err.code = "neko_browser_client_cdp_url_required";
    throw err;
  }
}

function pickContext(browser: Browser): BrowserContext {
  const contexts = typeof browser?.contexts === "function" ? browser.contexts() : [];
  return contexts[0] || null;
}

function pickPage(context: BrowserContext): Page {
  const pages = typeof context?.pages === "function" ? context.pages() : [];
  return pages[0] || null;
}

async function resolveBrowserContext(browser: Browser): Promise<BrowserContext> {
  let context = pickContext(browser);
  if (!context && typeof browser?.newContext === "function") {
    context = await browser.newContext();
  }
  if (context) {
    return context;
  }
  const err: CodedError = new Error("n.eko browser client could not resolve a browser context");
  err.code = "neko_browser_client_context_missing";
  throw err;
}

async function resolvePage(context: BrowserContext): Promise<Page> {
  let page = pickPage(context);
  if (!page && typeof context.newPage === "function") {
    page = await context.newPage();
  }
  if (page) {
    return page;
  }
  const err: CodedError = new Error("n.eko browser client could not resolve a page");
  err.code = "neko_browser_client_page_missing";
  throw err;
}

function isDuplicateBindingRegistration(err: unknown): boolean {
  return BINDING_ALREADY_REGISTERED_RE.test(String((err as { message?: unknown })?.message || ""));
}

async function disconnectBrowser(browser: Browser): Promise<void> {
  if (typeof browser.disconnect === "function") {
    await browser.disconnect();
    return;
  }
  if (typeof browser.close === "function") {
    await browser.close();
  }
}

export function createNekoBrowserClient({
  cdpHttpUrl,
  chromiumImpl = chromium,
}: {
  cdpHttpUrl?: unknown;
  chromiumImpl?: ChromiumImpl;
} = {}): NekoBrowserClient {
  assertCdpHttpUrl(cdpHttpUrl);

  let browser: Browser = null;
  let context: BrowserContext = null;
  let page: Page = null;

  async function ensureConnected(): Promise<void> {
    if (page) {
      return;
    }
    if (!chromiumImpl || typeof chromiumImpl.connectOverCDP !== "function") {
      const err: CodedError = new Error("createNekoBrowserClient: chromium.connectOverCDP is unavailable");
      err.code = "neko_browser_client_patchright_unavailable";
      throw err;
    }

    browser = await chromiumImpl.connectOverCDP(cdpHttpUrl);
    context = await resolveBrowserContext(browser);
    page = await resolvePage(context);
  }

  async function ensurePage(): Promise<Page> {
    await ensureConnected();
    return page;
  }

  return {
    async connect() {
      await ensureConnected();
      return this;
    },
    async getPage() {
      return await ensurePage();
    },
    async setViewportSize(viewport) {
      const activePage = await ensurePage();
      await activePage.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
    },
    async goto(url) {
      const activePage = await ensurePage();
      await activePage.goto(url, { waitUntil: "load" });
    },
    async addInitScript(source) {
      await ensureConnected();
      await context.addInitScript(source);
    },
    async exposeBinding(name, handler) {
      await ensureConnected();
      try {
        await context.exposeBinding(name, handler);
      } catch (err) {
        if (!isDuplicateBindingRegistration(err)) {
          throw err;
        }
      }
    },
    async evaluate(source) {
      const activePage = await ensurePage();
      return activePage.evaluate(source);
    },
    keyboard: {
      async insertText(text) {
        const activePage = await ensurePage();
        await activePage.keyboard.insertText(text);
      },
    },
    async close() {
      if (!browser) {
        return;
      }
      const activeBrowser = browser;
      browser = null;
      context = null;
      page = null;
      await disconnectBrowser(activeBrowser);
    },
  };
}
