/**
 * Amazon automated session management.
 *
 * Unique constraint: Amazon 2FA goes to the user's wife's phone. For
 * unattended operation, we CAN'T drive 2FA headlessly. Strategy:
 *   1. Probe session via deep check (nav greeting + /your-orders redirect)
 *   2. If dead, try email/password login up to the 2FA prompt
 *   3. If 2FA needed, emit INTERACTION kind=otp via ntfy → user forwards
 *      the 2FA code from wife's phone to their own phone → replies
 *
 * The INTERACTION flow works, but requires the user + wife to be available
 * together when a scheduled run triggers 2FA. For a daily scraping cadence
 * Amazon sessions typically last 30+ days, so 2FA events are infrequent.
 */

export async function ensureAmazonSession({ context: _context, page, sendInteractionAndWait, nextInteractionId }) {
  // Deep probe
  await page.goto('https://www.amazon.com/your-orders/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const url1 = page.url();
  if (!/\/ap\/(signin|challenge|mfa)/.test(url1)) {
    const loginForm = await page.locator('form[name="signIn"]').first().isVisible().catch(() => false);
    if (!loginForm && /\/your-orders|\/order-history/.test(url1)) return true;
  }

  const email = process.env.AMAZON_USERNAME;
  const password = process.env.AMAZON_PASSWORD;
  if (!email || !password) throw new Error('AMAZON_USERNAME/PASSWORD not set for auto-login');

  // Drive login
  await page.goto('https://www.amazon.com/gp/sign-in.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Email step
  const emailInput = page.locator('input[name="email"], input#ap_email').first();
  if (await emailInput.count()) {
    await emailInput.fill(email);
    await page.locator('input#continue, button#continue').first().click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Password step
  const passInput = page.locator('input[name="password"], input#ap_password').first();
  if (await passInput.count()) {
    await passInput.fill(password);
    await page.locator('input#signInSubmit, button[type="submit"]').first().click().catch(() => {});
    await page.waitForTimeout(5000);
  }

  // 2FA?
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
  if (/verification|two.?step|authenticator|passcode|code we sent|sent a text/i.test(bodyText)) {
    const resp = await sendInteractionAndWait({
      type: 'INTERACTION',
      request_id: nextInteractionId(),
      kind: 'otp',
      message: 'Amazon 2FA required. Check wife\'s phone for the code and reply.',
      schema: { type: 'object', properties: { code: { type: 'string', pattern: '^\\d{4,10}$' } }, required: ['code'] },
      timeout_seconds: 1800,
    });
    if (resp.status !== 'success' || !resp.data?.code) throw new Error('amazon_2fa_not_provided');
    const otpInput = page.locator('input[name="otpCode"], input#auth-mfa-otpcode, input[autocomplete="one-time-code"]').first();
    await otpInput.fill(resp.data.code);
    await page.locator('input#auth-signin-button, button[type="submit"]').first().click().catch(() => {});
    await page.waitForTimeout(6000);
  }

  // Verify
  await page.goto('https://www.amazon.com/your-orders/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const finalUrl = page.url();
  if (/\/ap\/(signin|challenge|mfa)/.test(finalUrl)) {
    throw new Error('amazon_login_incomplete_after_submit');
  }
  return true;
}
