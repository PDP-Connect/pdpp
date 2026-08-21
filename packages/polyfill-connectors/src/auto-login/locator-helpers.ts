// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Provider-neutral Playwright locator helpers shared across auto-login modules. */

import type { Locator } from "playwright";

/** `true` iff the first match becomes visible within 1s; never throws. */
export async function locatorIsVisible(locator: Locator): Promise<boolean> {
  return await locator
    .first()
    .isVisible({ timeout: 1000 })
    .catch((): boolean => false);
}

/**
 * `true` iff the first match is visible AND enabled; never throws.
 *
 * Visibility alone is not usability. Playwright reports a `disabled` control
 * as visible, so `locatorIsVisible` accepts rendered-but-inert elements — the
 * root cause behind Venmo's fabricated code prompt. Prefer this helper
 * wherever a `true` answer authorizes an irreversible act: clicking a control
 * that makes a provider dispatch a one-time code, or asking the owner for a
 * secret. A disabled control means the page is not ready for that act, and
 * treating it as ready spends the owner's real OTP budget.
 *
 * Deliberately a separate export rather than a change to `locatorIsVisible`:
 * the existing callers (reddit, github) ask a genuine visibility question and
 * must keep their current answers.
 */
export async function locatorIsUsable(locator: Locator): Promise<boolean> {
  const first = locator.first();
  const visible = await first.isVisible({ timeout: 1000 }).catch((): boolean => false);
  if (!visible) {
    return false;
  }
  return await first.isEnabled({ timeout: 1000 }).catch((): boolean => false);
}
