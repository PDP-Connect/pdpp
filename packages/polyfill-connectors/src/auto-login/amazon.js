/**
 * Amazon automated session management.
 *
 * Strategy:
 *   1. Probe session via deep check (navigate to /your-orders, check no
 *      signin redirect)
 *   2. If dead, drive email + password form through Amazon's two-step flow
 *   3. If 2FA prompted, emit INTERACTION kind=otp — owner replies with the
 *      code from their SMS or authenticator app
 *
 * Selectors notes (updated 2026-04-20):
 *   - Amazon's signin page has a HIDDEN autofill-hint input at
 *     `input[name="password"]#auth-credential-autofill-hint` that matches
 *     `input[name="password"]` but is not fillable. The real password input
 *     appears only after email+continue and uses `input#ap_password`. We
 *     prefer the specific ID and require visibility before filling.
 */

async function fillWhenVisible(page, locator, value, { timeout = 15000 } = {}) {
  // Find the first visible candidate out of the locator's matches. This
  // dodges Amazon's hidden autofill-hint inputs that share name= attrs
  // with the real form field.
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const n = await locator.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.fill(value);
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error('no visible match for locator within timeout');
}

export async function ensureAmazonSession({ context: _context, page, sendInteraction }) {
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

  // Drive login. Navigate to the signin page explicitly; a prior page may
  // have redirected from /your-orders and not shown the email field yet.
  await page.goto('https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Email step. Observed ids (2026-04-20):
  //   - `#ap_email_login` on the new FullPageUnifiedClaim signin flow
  //   - `#ap_email` on the legacy flow (some account tiers / regions)
  // We prefer the new id first but fall back to the legacy one. We also
  // skip filling if the field already has the right value.
  const emailLoc = page.locator('input#ap_email_login, input#ap_email, input[name="email"]');
  const currentEmail = await emailLoc.first().inputValue().catch(() => '');
  if (currentEmail !== email) {
    await fillWhenVisible(page, emailLoc, email);
  }
  // Amazon's unified-claim signin page uses an unlabeled <input type="submit">
  // with aria-labelledby="continue-announce" — no stable id. Cover all shapes.
  await page.locator('input#continue, button#continue, input[type="submit"][aria-labelledby~="continue-announce"], input[type="submit"], button[type="submit"]').first().click().catch(() => {});
  await page.waitForTimeout(3000);

  // Password step — `#ap_password` remains stable; `input[name="password"]`
  // also matches a hidden autofill hint, so we prefer the id + require vis.
  await fillWhenVisible(page, page.locator('input#ap_password'), password);
  await page.locator('input#signInSubmit, input[type="submit"], button[type="submit"]').first().click().catch(() => {});
  await page.waitForTimeout(5000);

  // 2FA?
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
  if (/verification|two.?step|authenticator|passcode|code we sent|sent a text/i.test(bodyText)) {
    const resp = await sendInteraction({
      kind: 'otp',
      message: 'Amazon 2FA required. Check your phone / authenticator and reply with the code.',
      schema: { type: 'object', properties: { code: { type: 'string', pattern: '^\\d{4,10}$' } }, required: ['code'] },
      timeout_seconds: 1800,
    });
    if (resp.status !== 'success' || !resp.data?.code) throw new Error('amazon_2fa_not_provided');
    await fillWhenVisible(page, page.locator('input[name="otpCode"], input#auth-mfa-otpcode, input[autocomplete="one-time-code"]'), resp.data.code);
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
