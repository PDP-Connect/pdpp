/**
 * ChatGPT automated session management.
 *
 * ChatGPT auth expires after ~30 days. When expired, the user must either
 * sign in via Google SSO (couldn't be fully automated without Google creds)
 * or email+password.
 *
 * the owner's account uses `everyone@appears.blue` + password (env: CHATGPT_USERNAME
 * / CHATGPT_PASSWORD). ChatGPT has Cloudflare protection and may demand 2FA.
 *
 * If auto-login fails (Cloudflare challenge, unexpected UI), fall back to
 * INTERACTION manual_action so the owner can be prompted.
 */

export async function ensureChatGptSession({ context: _context, page, sendInteractionAndWait, nextInteractionId }) {
  // Probe: can we hit /api/auth/session and get user?
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const session = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  });
  if (session && session.user) return true;

  // Session dead. Try email/password flow.
  const email = process.env.CHATGPT_USERNAME;
  const password = process.env.CHATGPT_PASSWORD;
  if (!email || !password) throw new Error('CHATGPT_USERNAME/PASSWORD not set');

  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Find "Log in" or "Continue with email"
  const loginBtn = page.locator(':text-matches("Log in|Continue with email", "i")').first();
  if (await loginBtn.count()) await loginBtn.click().catch(() => {});
  await page.waitForTimeout(2500);

  // Email input
  const emailIn = page.locator('input[type="email"], input[name="username"], input[name="email"]').first();
  if (!(await emailIn.count())) {
    // Unexpected — ask the owner
    await sendInteractionAndWait({
      type: 'INTERACTION',
      request_id: nextInteractionId(),
      kind: 'manual_action',
      message: 'ChatGPT session expired and auto-login UI is unexpected (possibly Cloudflare challenge). Open chatgpt.com on the laptop and log in manually, then re-run.',
      timeout_seconds: 1800,
    });
    throw new Error('chatgpt_login_unexpected_ui');
  }
  await emailIn.fill(email);
  await page.locator('button[type="submit"], :text-is("Continue")').first().click().catch(() => {});
  await page.waitForTimeout(3000);

  const passwordIn = page.locator('input[type="password"]').first();
  if (!(await passwordIn.count())) throw new Error('chatgpt_login_no_password_field');
  await passwordIn.fill(password);
  await page.locator('button[type="submit"], :text-is("Continue")').first().click().catch(() => {});
  await page.waitForTimeout(6000);

  // Verify
  const verify = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  });
  if (verify && verify.user) return true;

  // Something went wrong — maybe CAPTCHA or 2FA. Ask the owner.
  await sendInteractionAndWait({
    type: 'INTERACTION',
    request_id: nextInteractionId(),
    kind: 'manual_action',
    message: 'ChatGPT login submitted but session still not active. Likely Cloudflare challenge or 2FA — please log in on chatgpt.com manually.',
    timeout_seconds: 1800,
  });
  throw new Error('chatgpt_login_post_submit_failed');
}
