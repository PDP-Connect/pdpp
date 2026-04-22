/**
 * ChatGPT automated session management.
 *
 * ChatGPT auth expires after ~30 days. When expired, the user must either
 * sign in via Google SSO (couldn't be fully automated without Google creds)
 * or email+password.
 *
 * Env: CHATGPT_USERNAME / CHATGPT_PASSWORD. ChatGPT has Cloudflare protection
 * and may demand 2FA (app approval or code entry).
 *
 * If auto-login fails (Cloudflare challenge, unexpected UI), fall back to
 * INTERACTION manual_action so the user can be prompted.
 */

async function checkSession(page) {
  try {
    const r = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        const text = await r.text();
        try { return JSON.parse(text); } catch { return null; }
      } catch { return null; }
    });
    return r && r.user;
  } catch { return false; }
}

async function checkLoggedInViaDOM(page) {
  try {
    return await page.evaluate(() => {
      const allButtons = document.querySelectorAll('button, a');
      const hasLoginButton = Array.from(allButtons).some(el => {
        const text = el.textContent?.toLowerCase() || '';
        return text.includes('log in') || text.includes('sign up');
      });
      if (hasLoginButton) return false;
      const hasSidebar = !!document.querySelector('nav[aria-label="Chat history"]') ||
                         !!document.querySelector('nav a[href^="/c/"]') ||
                         document.querySelectorAll('nav').length > 0;
      const hasUserMenu = !!document.querySelector('[data-testid="profile-button"]') ||
                          !!document.querySelector('button[aria-label*="User menu"]');
      return hasSidebar || hasUserMenu;
    });
  } catch { return false; }
}

export async function ensureChatGptSession({ context: _context, page, sendInteraction }) {
  // Probe: can we hit /api/auth/session and get user?
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  if (await checkSession(page)) return true;

  // Session dead. Try email/password flow.
  const email = process.env.CHATGPT_USERNAME;
  const password = process.env.CHATGPT_PASSWORD;
  if (!email || !password) throw new Error('CHATGPT_USERNAME/PASSWORD not set');

  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Click "Log in" button to reach auth.openai.com
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, a');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'log in') { btn.click(); return true; }
    }
    return false;
  });
  await page.waitForTimeout(3000);

  // Email input
  const emailIn = page.locator('input[type="email"], input[name="username"], input[name="email"]').first();
  if (!(await emailIn.count())) {
    await sendInteraction({
      kind: 'manual_action',
      message: 'ChatGPT session expired and auto-login UI is unexpected (possibly Cloudflare challenge). Open chatgpt.com on the laptop and log in manually, then re-run.',
      timeout_seconds: 1800,
    });
    throw new Error('chatgpt_login_unexpected_ui');
  }
  await emailIn.fill(email);
  await page.locator('button[type="submit"], :text-is("Continue")').first().click().catch(() => {});
  await page.waitForTimeout(3000);

  // ChatGPT may default to email-code login; click "Continue with password" if present.
  const continueWithPw = page.locator(':text-matches("Continue with password", "i")').first();
  if (await continueWithPw.count()) {
    await continueWithPw.click();
    await page.waitForTimeout(3000);
  }

  // Fill password if the field is present.
  const passwordIn = page.locator('input[type="password"]').first();
  if (await passwordIn.count()) {
    await passwordIn.fill(password);
    await page.locator('button[type="submit"], :text-is("Continue")').first().click().catch(() => {});
    await page.waitForTimeout(5000);

    // Handle 2FA code entry if prompted (input[name="code"], tel, or numeric).
    const tfaIn = page.locator('input[name="code"], input[type="tel"], input[inputmode="numeric"]').first();
    if (await tfaIn.count()) {
      const resp = await sendInteraction({
        kind: 'text_input',
        message: 'ChatGPT requires a 2FA verification code. Enter the 6-digit code:',
        timeout_seconds: 300,
      });
      if (resp && resp.value) {
        await tfaIn.fill(resp.value);
        await page.locator('button[type="submit"]').first().click().catch(() => {});
        await page.waitForTimeout(5000);
      }
    }
  } else {
    // No password field — might be email-code-only or needs manual intervention.
    throw new Error('chatgpt_login_no_password_field');
  }

  // Poll for up to 90s without navigating away — the user may need to approve
  // a 2FA push notification or complete a Cloudflare challenge in the browser.
  for (let attempt = 0; attempt < 18; attempt++) {
    await page.waitForTimeout(5000);
    // Check both DOM-based login detection and session API.
    if (await checkLoggedInViaDOM(page)) return true;
    if (await checkSession(page)) return true;
  }

  // Last resort — ask the user to complete login manually.
  await sendInteraction({
    kind: 'manual_action',
    message: 'ChatGPT login submitted but session still not active after 90s. Please complete login in the browser window (Cloudflare challenge, 2FA, etc.).',
    timeout_seconds: 1800,
  });

  // One more check after manual intervention.
  await page.waitForTimeout(3000);
  if (await checkSession(page) || await checkLoggedInViaDOM(page)) return true;

  throw new Error('chatgpt_login_post_submit_failed');
}
