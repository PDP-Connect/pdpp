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
