export const PLATFORMS = {
  amazon: {
    label: 'Amazon',
    bootstrapUrl: 'https://www.amazon.com/gp/sign-in.html',
    probeUrl: 'https://www.amazon.com/gp/your-account/order-history',
    async isLoggedIn(page) {
      const url = page.url();
      if (/\/ap\/signin/i.test(url)) return false;
      const hasOrderHistory = await page
        .locator('h1, #navFooter, .your-orders-page')
        .first()
        .isVisible()
        .catch(() => false);
      const title = await page.title().catch(() => '');
      return hasOrderHistory && !/sign[- ]in/i.test(title);
    },
  },
  chatgpt: {
    label: 'ChatGPT',
    bootstrapUrl: 'https://chatgpt.com/',
    probeUrl: 'https://chatgpt.com/api/auth/session',
    async isLoggedIn(page) {
      try {
        const body = await page.evaluate(async () => {
          const r = await fetch('/api/auth/session', { credentials: 'include' });
          if (!r.ok) return null;
          return r.json();
        });
        return !!(body && body.user);
      } catch {
        return false;
      }
    },
  },
  usaa: {
    label: 'USAA',
    bootstrapUrl: 'https://www.usaa.com/inet/wc/logon',
    probeUrl: 'https://www.usaa.com/',
    async isLoggedIn(_page, context) {
      // Cookie-based probe: USAA sets UsaaMbWebMemberLoggedIn only when authenticated.
      // Resilient to URL reorganizations that break path-based probes.
      try {
        const cookies = await context.cookies('https://www.usaa.com/');
        const loggedInCookie = cookies.find((c) => c.name === 'UsaaMbWebMemberLoggedIn');
        if (loggedInCookie && loggedInCookie.value && loggedInCookie.value !== 'false') return true;
        const hasSessionTokens = cookies.some((c) => /^(LtpaToken2|AST|MemberGlobalSession)$/.test(c.name));
        return hasSessionTokens;
      } catch {
        return false;
      }
    },
  },
};
