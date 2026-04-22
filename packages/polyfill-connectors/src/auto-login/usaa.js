/**
 * USAA automated re-login.
 *
 * Given a Playwright context whose session has died, drives the full login
 * flow using stored credentials. Emits an INTERACTION kind=otp via the
 * provided `sendInteraction` callback; that in turn fires ntfy to
 * the owner's phone. the owner replies with the 6-digit code over the inbox (or by
 * writing to /tmp/usaa-otp.txt during manual testing).
 *
 * Returns true on success; throws on hard failure.
 */

export async function ensureUsaaSession({ context, page, sendInteraction }) {
  // Probe first — no need to re-login if session is alive.
  const cookies = await context.cookies('https://www.usaa.com/');
  const loggedIn = cookies.find((c) => c.name === 'UsaaMbWebMemberLoggedIn');
  if (loggedIn && loggedIn.value && loggedIn.value !== 'false') {
    // Verify by hitting a cheap authenticated page
    await page.goto('https://www.usaa.com/my/usaa', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
    if (/Log Off|Good (Morning|Afternoon|Evening)/i.test(bodyText)) return true;
  }

  // Session is dead or suspect — drive login.
  const username = process.env.USAA_USERNAME;
  const password = process.env.USAA_PASSWORD;
  if (!username || !password) throw new Error('USAA_USERNAME/PASSWORD not set; cannot auto-login');

  await page.goto('https://www.usaa.com/my/logon', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Give React a beat to initialize the form. USAA's SPA renders the
  // memberId input immediately but hasn't bound React event handlers yet —
  // filling in that <1s window produces a value that React discards.
  await page.waitForSelector('input[name="memberId"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.fill('input[name="memberId"]', username);
  // Wait until Next is enabled; USAA gates it on client-side validation.
  // If it stays disabled, tick a key event to try again, then check.
  try {
    await page.locator('#next-button:not([disabled])').waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // Fallback: press a throwaway key to nudge React
    await page.locator('input[name="memberId"]').press('End').catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.click('#next-button');
  try {
    await page.waitForSelector('input[name="password"]', { timeout: 25000 });
  } catch (err) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type, placeholder: i.placeholder })),
    ).catch(() => []);
    throw new Error(`password field never appeared after Next click. url=${page.url()} inputs=${JSON.stringify(inputs)} body-preview=${body.slice(0, 300)}`);
  }
  await page.fill('input[name="password"]', password);
  await page.waitForTimeout(500);
  await page.click('#next-button');
  await page.waitForTimeout(5000);

  const bodyText = (await page.locator('body').innerText()).slice(0, 1000);

  if (/Text security code/i.test(bodyText)) {
    // Trigger the SMS + ask the owner for the code via INTERACTION
    await page.locator(':text-matches("Text security code to:", "i")').first().click().catch(async () => {
      await page.locator('#miam-choice-container\\ 0-id').click();
    });
    await page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]', { timeout: 20000 });

    const resp = await sendInteraction({
      kind: 'otp',
      message: 'USAA sent a 6-digit security code to your phone. Reply with the code to continue.',
      schema: { type: 'object', properties: { code: { type: 'string', pattern: '^\\d{6}$' } }, required: ['code'] },
      timeout_seconds: 600,
    });
    if (resp.status !== 'success' || !resp.data?.code) throw new Error('USAA OTP not provided');

    const otpInput = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]').first();
    await otpInput.fill(resp.data.code);
    await page.click('button[type="submit"], #next-button').catch(() => {});
    await page.waitForTimeout(6000);
  }

  // Verify we're logged in now
  const finalText = (await page.locator('body').innerText()).slice(0, 500);
  if (!/Log Off/i.test(finalText)) {
    throw new Error('USAA login completed but final state shows no Log Off — may need fresh bootstrap');
  }
  return true;
}
