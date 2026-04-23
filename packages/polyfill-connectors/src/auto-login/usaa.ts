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

import type { BrowserContext, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";

const LOGGED_IN_TEXT = /Log Off|Good (Morning|Afternoon|Evening)/i;
const LOG_OFF_TEXT = /Log Off/i;
const TEXT_CODE_PROMPT = /Text security code/i;

interface EnsureUsaaSessionArgs {
  context: BrowserContext;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

interface InputProbe {
  name: string;
  placeholder: string;
  type: string;
}

export async function ensureUsaaSession({ context, page, sendInteraction }: EnsureUsaaSessionArgs): Promise<boolean> {
  // Probe first — no need to re-login if session is alive.
  const cookies = await context.cookies("https://www.usaa.com/");
  const loggedIn = cookies.find((c): boolean => c.name === "UsaaMbWebMemberLoggedIn");
  if (loggedIn?.value && loggedIn.value !== "false") {
    // Verify by hitting a cheap authenticated page
    await page
      .goto("https://www.usaa.com/my/usaa", {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      })
      .catch((): undefined => undefined);
    await page.waitForTimeout(3000);
    const bodyText = (
      await page
        .locator("body")
        .innerText()
        .catch((): string => "")
    ).slice(0, 500);
    if (LOGGED_IN_TEXT.test(bodyText)) {
      return true;
    }
  }

  // Session is dead or suspect — drive login.
  const username = process.env.USAA_USERNAME;
  const password = process.env.USAA_PASSWORD;
  if (!(username && password)) {
    throw new Error("USAA_USERNAME/PASSWORD not set; cannot auto-login");
  }

  await page.goto("https://www.usaa.com/my/logon", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Give React a beat to initialize the form. USAA's SPA renders the
  // memberId input immediately but hasn't bound React event handlers yet —
  // filling in that <1s window produces a value that React discards.
  await page.waitForSelector('input[name="memberId"]', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.fill('input[name="memberId"]', username);
  // Wait until Next is enabled; USAA gates it on client-side validation.
  // If it stays disabled, tick a key event to try again, then check.
  try {
    await page.locator("#next-button:not([disabled])").waitFor({ state: "visible", timeout: 5000 });
  } catch {
    // Fallback: press a throwaway key to nudge React
    await page
      .locator('input[name="memberId"]')
      .press("End")
      .catch((): undefined => undefined);
    await page.waitForTimeout(500);
  }
  await page.click("#next-button");
  try {
    await page.waitForSelector('input[name="password"]', { timeout: 25_000 });
  } catch {
    const body = (
      await page
        .locator("body")
        .innerText()
        .catch((): string => "")
    ).slice(0, 800);
    const inputs = await page
      .evaluate((): InputProbe[] => {
        const els = document.querySelectorAll("input");
        return Array.from(els).map(
          (i): InputProbe => ({
            name: i.name,
            type: i.type,
            placeholder: i.placeholder,
          })
        );
      })
      .catch((): InputProbe[] => []);
    throw new Error(
      `password field never appeared after Next click. url=${page.url()} inputs=${JSON.stringify(inputs)} body-preview=${body.slice(0, 300)}`
    );
  }
  await page.fill('input[name="password"]', password);
  await page.waitForTimeout(500);
  await page.click("#next-button");
  await page.waitForTimeout(5000);

  const bodyText = (await page.locator("body").innerText()).slice(0, 1000);

  if (TEXT_CODE_PROMPT.test(bodyText)) {
    // Trigger the SMS + ask the owner for the code via INTERACTION
    await page
      .locator(':text-matches("Text security code to:", "i")')
      .first()
      .click()
      .catch(async (): Promise<void> => {
        await page.locator("#miam-choice-container\\ 0-id").click();
      });
    await page.waitForSelector(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]',
      { timeout: 20_000 }
    );

    const resp = await sendInteraction({
      kind: "otp",
      message: "USAA sent a 6-digit security code to your phone. Reply with the code to continue.",
      schema: {
        type: "object",
        properties: { code: { type: "string", pattern: "^\\d{6}$" } },
        required: ["code"],
      },
      timeout_seconds: 600,
    });
    if (resp.status !== "success" || !resp.data?.code) {
      throw new Error("USAA OTP not provided");
    }

    const otpInput = page
      .locator('input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]')
      .first();
    await otpInput.fill(resp.data.code);
    await page.click('button[type="submit"], #next-button').catch((): undefined => undefined);
    await page.waitForTimeout(6000);
  }

  // Verify we're logged in now
  const finalText = (await page.locator("body").innerText()).slice(0, 500);
  if (!LOG_OFF_TEXT.test(finalText)) {
    throw new Error("USAA login completed but final state shows no Log Off — may need fresh bootstrap");
  }
  return true;
}
