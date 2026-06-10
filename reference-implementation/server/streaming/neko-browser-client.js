import { chromium } from 'patchright';

function assertCdpHttpUrl(cdpHttpUrl) {
  if (typeof cdpHttpUrl !== 'string' || cdpHttpUrl.length === 0) {
    const err = new Error('createNekoBrowserClient: cdpHttpUrl is required');
    err.code = 'neko_browser_client_cdp_url_required';
    throw err;
  }
}

function pickContext(browser) {
  const contexts = typeof browser?.contexts === 'function' ? browser.contexts() : [];
  return contexts[0] || null;
}

function pickPage(context) {
  const pages = typeof context?.pages === 'function' ? context.pages() : [];
  return pages[0] || null;
}

export function createNekoBrowserClient({ cdpHttpUrl, chromiumImpl = chromium } = {}) {
  assertCdpHttpUrl(cdpHttpUrl);

  let browser = null;
  let context = null;
  let page = null;

  async function ensureConnected() {
    if (page) return;
    if (!chromiumImpl || typeof chromiumImpl.connectOverCDP !== 'function') {
      const err = new Error('createNekoBrowserClient: chromium.connectOverCDP is unavailable');
      err.code = 'neko_browser_client_patchright_unavailable';
      throw err;
    }

    browser = await chromiumImpl.connectOverCDP(cdpHttpUrl);
    context = pickContext(browser);
    if (!context && typeof browser?.newContext === 'function') {
      context = await browser.newContext();
    }
    if (!context) {
      const err = new Error('n.eko browser client could not resolve a browser context');
      err.code = 'neko_browser_client_context_missing';
      throw err;
    }

    page = pickPage(context);
    if (!page && typeof context.newPage === 'function') {
      page = await context.newPage();
    }
    if (!page) {
      const err = new Error('n.eko browser client could not resolve a page');
      err.code = 'neko_browser_client_page_missing';
      throw err;
    }
  }

  async function ensurePage() {
    await ensureConnected();
    return page;
  }

  return {
    async connect() {
      await ensureConnected();
      return this;
    },
    async getPage() {
      return ensurePage();
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
      await activePage.goto(url, { waitUntil: 'load' });
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
        if (!/binding .* already registered|already exists/i.test(String(err?.message || ''))) throw err;
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
      if (!browser) return;
      const activeBrowser = browser;
      browser = null;
      context = null;
      page = null;
      if (typeof activeBrowser.disconnect === 'function') {
        await activeBrowser.disconnect();
        return;
      }
      if (typeof activeBrowser.close === 'function') {
        await activeBrowser.close();
      }
    },
  };
}
