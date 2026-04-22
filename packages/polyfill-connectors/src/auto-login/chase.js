/**
 * Chase automated session management.
 *
 * Chase uses `mds-*` custom elements (Web Components with Shadow DOM) for
 * its 2FA flow. The visual options and submit buttons are not clickable
 * via attribute selectors on the host elements — the host elements have
 * zero bounding box because the actual rendered content lives inside
 * mds-list's shadow root. Playwright's text-based and role-based locators
 * pierce shadow DOM and return the real clickable nodes.
 *
 * Flow:
 *   1. Probe — navigate to /web/auth/dashboard, check for "Sign out" text
 *   2. Logon — fill #userId-text-input-field + #password-text-input-field
 *      and click #signin-button
 *   3. Identity challenge — "Confirm Your Identity" page asks the user to
 *      pick a method (text / call / email). We auto-pick per
 *      CHASE_2FA_METHOD env (default 'text'). The method options render as
 *      `<a href="javascript:void(0)">` with aria-label starting with the
 *      short label ("Get a text" / "Call me" / "Email me").
 *   4. OTP — an `mds-text-input-secure#otpInput` wraps a shadow-DOM
 *      `<input type="password">`. Playwright's CSS engine pierces open
 *      shadow roots, so `input[type="password"]` finds the inner input.
 *      `pressSequentially` fires per-character events that the framework's
 *      validation listens for (bulk fill() did not trigger validation).
 *   5. Submit — `text="Next"` (pierces shadow to the inner button label).
 *
 * Selectors verified live 2026-04-21. Detailed probe history is in
 * packages/polyfill-connectors/scripts/probe-chase-*.mjs.
 */

const DASHBOARD_URL = 'https://secure.chase.com/web/auth/dashboard';
const LOGON_URL = 'https://secure.chase.com/web/auth/';

const METHOD_LABELS = {
  text: 'Get a text', sms: 'Get a text',
  voice: 'Call me', call: 'Call me',
  email: 'Email me',
};

async function probeSession(page) {
  // Auto-wait on "Sign out" being visible (logged in) or the logon form input
  // being visible (logged out), whichever shows first. Race with a timeout to
  // tolerate Chase serving a slow response.
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const signOutVisible = await page.getByText(/Sign Out|Log Off/i).first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  return signOutVisible;
}

export async function ensureChaseSession({ context: _context, page, sendInteractionAndWait, nextInteractionId }) {
  if (await probeSession(page)) return true;

  const username = process.env.CHASE_USERNAME;
  const password = process.env.CHASE_PASSWORD;
  if (!username || !password) throw new Error('CHASE_USERNAME/PASSWORD not set');

  await page.goto(LOGON_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Logon form — ID pattern changed 2026-04-21:
  //   old: #userId-text-input-field / #password-text-input-field
  //   new: #userId-input-field-input / #password-input-field-input (+name=username)
  // Accept both so we work across Chase's redesigns without a release.
  const userField = page.locator(
    'input#userId-input-field-input, input[name="username"], input#userId-text-input-field, input[name="userId"]'
  ).first();
  await userField.waitFor({ state: 'visible', timeout: 15000 });
  await userField.fill(username);

  const passField = page.locator(
    'input#password-input-field-input, input#password-text-input-field, input[name="password"], input[type="password"]'
  ).first();
  await passField.fill(password);

  await page.locator('button#signin-button, button[type="submit"]').first().click({ timeout: 5000 });

  // After submit, Chase either advances to the challenge page or loads the
  // dashboard. Wait for a recognizable post-submit state rather than a fixed
  // sleep. Race: challenge indicator OR sign-out visible.
  await Promise.race([
    page.getByText(/Confirm Your Identity|Choose a confirmation method/i).first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => null),
    page.getByText(/Sign Out|Log Off/i).first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => null),
  ]);

  // Identity challenge — method chooser.
  const onChallenge = await page.getByText(/Confirm Your Identity|Choose a confirmation method/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (onChallenge) {
    const method = (process.env.CHASE_2FA_METHOD || 'text').toLowerCase();
    const label = METHOD_LABELS[method] || METHOD_LABELS.text;

    await page.getByRole('link', { name: new RegExp(`^${label}`, 'i') })
      .first()
      .click({ timeout: 10000 });

    // Wait for the Next button to be enabled/visible before clicking it.
    const nextBtn = page.locator('text="Next"').first();
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await nextBtn.click({ timeout: 10000 });

    // Wait for either the OTP input page or the dashboard.
    await Promise.race([
      page.getByText(/Enter (the|your) code|identification code|verification code/i).first()
        .waitFor({ state: 'visible', timeout: 20000 })
        .catch(() => null),
      page.getByText(/Sign Out|Log Off/i).first()
        .waitFor({ state: 'visible', timeout: 20000 })
        .catch(() => null),
    ]);
  }

  // OTP entry step.
  const onOtp = await page.getByText(/Enter (the|your) code|identification code|verification code|we sent/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (onOtp) {
    const resp = await sendInteractionAndWait({
      type: 'INTERACTION',
      request_id: nextInteractionId(),
      kind: 'otp',
      message: 'Chase sent a 2FA code. Reply with it.',
      schema: {
        type: 'object',
        properties: { code: { type: 'string', pattern: '^[0-9]{4,10}$' } },
        required: ['code'],
      },
      timeout_seconds: 600,
    });
    if (resp.status !== 'success' || !resp.data?.code) throw new Error('chase_otp_not_provided');

    const otpInput = page.locator('input[type="password"]').first();
    await otpInput.click({ timeout: 5000 });
    await otpInput.fill('');
    await otpInput.pressSequentially(resp.data.code, { delay: 60 });

    // Best-effort: tick any "remember this device" / "don't ask again"
    // checkbox before submitting. Chase sets a session-only
    // `_tmprememberme` cookie by default; it's upgraded to a persistent
    // trust cookie when the user opts in via a checkbox on the OTP page.
    // Without this, every run requires a fresh OTP. If the checkbox
    // isn't present or is already checked, this is a no-op.
    const rememberPatterns = [
      'input[type="checkbox"]#rememberMe',
      'input[type="checkbox"]#trustDevice',
      'input[type="checkbox"][name="rememberMe"]',
      'input[type="checkbox"][name*="remember" i]',
      'input[type="checkbox"][name*="trust" i]',
      'label:has-text("Remember") input[type="checkbox"]',
      'label:has-text("Trust this device") input[type="checkbox"]',
      "label:has-text(\"Don't ask\") input[type=\"checkbox\"]",
    ];
    for (const sel of rememberPatterns) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count().catch(() => 0)) > 0 && !(await loc.isChecked().catch(() => true))) {
          await loc.check({ timeout: 2000 }).catch(() => {});
          break;
        }
      } catch { /* next pattern */ }
    }

    const submitByText = page.locator('text="Next"').first();
    if (await submitByText.count().catch(() => 0)) {
      await submitByText.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page.locator('mds-button#next-content').click({ timeout: 5000 }).catch(async () => {
        await otpInput.press('Enter').catch(() => {});
      });
    }

    // Wait for redirect to dashboard (Sign out visible).
    await page.getByText(/Sign Out|Log Off/i).first()
      .waitFor({ state: 'visible', timeout: 30000 });
  }

  if (!(await probeSession(page))) {
    throw new Error('chase_login_incomplete_after_submit');
  }
  return true;
}
