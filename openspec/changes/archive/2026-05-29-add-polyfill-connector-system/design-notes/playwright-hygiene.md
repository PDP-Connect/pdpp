# Playwright hygiene — known tech debt

**Status:** deliberate debt, scoped
**Raised:** 2026-04-19

## The problem

Several auto-login helpers use `page.waitForTimeout(ms)` as a synchronization primitive. This is an explicit Playwright anti-pattern — the docs call it out as "strongly discouraged" because it makes tests flaky, slow, and brittle to timing variance. It's in our code because the helpers were adapted from pre-existing scrapers that used the pattern, and we preserved working behavior while extending them.

Count as of 2026-04-19:

| File | `waitForTimeout` sites | Fixed today |
|---|---|---|
| `src/auto-login/github.js` | 0 (refactored) | ✅ |
| `src/auto-login/usaa.js` | 3 | — |
| `src/auto-login/amazon.js` | 6 | — |
| `src/auto-login/chatgpt.js` | 5 | — |
| `bin/bootstrap-github-pat.js` | 0 (refactored) | ✅ |

## Correct replacements per use case

- **After navigation** → `Promise.all([page.waitForNavigation(...), page.click(...)])` or `page.waitForURL(regex)`.
- **Waiting for element to appear** → `locator.waitFor({ state: 'visible' })`.
- **Waiting for element to disappear** → `locator.waitFor({ state: 'detached' })` or `expect(locator).toBeHidden()`.
- **After form submit** → `page.waitForLoadState('networkidle')` for SPA pages, `waitForNavigation` for classic.
- **Between keystrokes** → `page.locator(...).pressSequentially(text, { delay: 30 })` rather than fill-then-sleep.
- **Waiting for AJAX to settle** → `page.waitForResponse(urlMatcher)` — the only truly correct option when an element doesn't change.

## Why we didn't fix all of it today

1. **Risk.** USAA/Amazon/ChatGPT helpers are the only way those connectors work today. A refactor without live testing against each platform is a regression risk.
2. **Each platform needs live testing.** USAA needs a 2FA code; Amazon is blocked by wife's-phone 2FA; ChatGPT needs fresh session + we don't want to trigger Cloudflare.
3. **ROI.** `waitForTimeout` works; it's just slow and fragile. The `orchestrate run <connector>` path doesn't hit these re-login paths unless the session is dead, which is rare.

## When to fix

- **Before adding a new browser connector** that copies these patterns. Clean the source so new code starts right.
- **During USAA refresh session expiry** — next time we hit the re-login path live, refactor that file.
- **Before open-sourcing or formalizing as reference material.** These helpers are examples readers will copy.

## Acceptance criteria for "done"

1. `grep -r waitForTimeout packages/polyfill-connectors/src packages/polyfill-connectors/bin` returns zero.
2. Each auto-login helper has at least one end-to-end test that drives it through a fresh-session state.
3. Flake rate on 100 repeated runs across connectors stays below 2%.

## Related

- `connector-configuration-open-question.md` — a cleanly-specified `credentials_schema` would let us lift INTERACTION timing behavior out of the connector code and into the runtime, removing a chunk of the brittle logic entirely.
