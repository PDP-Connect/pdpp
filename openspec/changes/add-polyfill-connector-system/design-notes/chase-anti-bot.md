# Chase anti-bot investigation (2026-04-21)

**Status:** partially resolved — base v0.1 streams (accounts, transactions, balances) land successfully; statements stream written but pending clean-profile login.

## What we learned

### It's NOT Akamai, NOT vanilla anti-headless fingerprinting

The common assumption — and what our initial research pointed at — was that Chase uses Akamai Bot Manager Premier which detects headless Chromium at login. Four findings disprove that for this specific flow:

1. **No Akamai cookies are set by Chase.** A fresh browser profile landing on chase.com gets no `_abck`, `bm_sz`, `bm_sv`, or `ak_bmsc` cookies. These are Akamai's signature cookies. If they were using Akamai Premier on the login path, we'd see them.
2. **Fresh profiles authenticate without any stealth measures.** A brand-new persistent-context profile (tmp dir, no prior cookies) launched under `xvfb-run` with vanilla Playwright signed in successfully and reached the "Confirm Your Identity" 2FA page on the first attempt. No patchright, no rebrowser, no special flags needed.
3. **The persistent daemon profile is specifically blocked.** The same credentials, same Xvfb wrapper, same `rebrowser-playwright` binary — but using the persistent profile at `~/.pdpp/browser-profile/` — gets bounced to `/#/logon/logon/error` within 1 second of submit, regardless of how the form was filled.
4. **Wiping Chase's cookies from the profile didn't help.** Cleared 39 → 0 Chase cookies, restarted the daemon, retried login. Still blocked.

### What IS happening

Chase's persistent-profile rejection is almost certainly based on **localStorage / IndexedDB / service-worker state** or **device fingerprinting** (WebGL vendor, font list, canvas) accumulated across repeated failed logins. The profile has a "bad device" mark that survives cookie wipes.

Evidence: one of the remaining cookies before the wipe was `xferCount=3` — Chase's internal "how many times this profile has been bounced to the error page" counter. That cookie alone suggests Chase tracks profile-level reputation beyond standard session state.

### What worked

The fresh-profile probe in `scripts/probe-chase-fresh-profile.mjs` succeeds end-to-end with:

- `rebrowser-playwright` (drop-in Playwright fork, patches Runtime.Enable CDP leak)
- Under `xvfb-run` with headful Chromium (no `--headless`, no `--hide-scrollbars`, no `--mute-audio`)
- Fresh persistent-context dir (new tmp dir per run)
- Warm-up nav to `chase.com` home before the logon URL
- Standard form fill + click

Fresh profile got to `#/logon/caas/challenge/index;caas=options;pageExperienceType=caasArea;step=confirmIdentity` — the 2FA method-chooser. Would complete with an OTP.

## Selectors updated 2026-04-21

Chase changed the login form input IDs without fanfare:

- **Old:** `#userId-text-input-field` / `#password-text-input-field`
- **New:** `#userId-input-field-input` (also `name="username"`) / `#password-input-field-input`

`src/auto-login/chase.js` now accepts both.

## Infrastructure added to the daemon

Browser daemon gained two anti-detection capabilities that are off by default but available for connectors that need them:

1. **Xvfb mode** (`pdpp-connectors browser start --xvfb`) — wraps the daemon under `xvfb-run` so Chromium runs headful on a virtual display. No human-attached monitor required. Xvfb must be installed (`apt install xvfb`).
2. **rebrowser-playwright import** — drop-in replacement for `playwright` in `bin/browser-daemon-worker.js`. Patches `Runtime.Enable` so CDP presence isn't detectable via `Error.stack` side channel. Transparent to consumer code.

Both are kept in place for future use even though the Chase block turned out to be something else — they're cheap and they help with actual Akamai-protected sites.

## What's blocked right now

Chase `statements` stream code is complete (see `connectors/chase/index.js` `downloadStatementPdf`, `enumerateStatementRows`, etc.) but hasn't been validated against real statement PDFs because the persistent-profile block means my autonomous runs fail at login.

## Paths forward

Three options, ranked by cleanliness:

### Option A — Dedicated ephemeral Chase profile
The Chase connector creates a new `chromium.launchPersistentContext(tmpDir)` per run (not using the shared daemon). User delivers OTP each run. Doesn't scale to unattended operation but matches how Chase treats "untrusted device" auth anyway.

### Option B — Wipe the daemon profile's localStorage + IndexedDB + service workers for chase.com
More surgical than a full profile wipe. If successful, the daemon can continue to be shared across connectors. Requires:
```js
await ctx.clearCookies({ domain: /chase/i });
await page.evaluate(() => {
  // Hit a chase.com page first so localStorage origin is accessible
  localStorage.clear();
  sessionStorage.clear();
});
// Plus IndexedDB wipe via CDP Storage.clearDataForOrigin
```

### Option C — Full daemon profile reset + re-bootstrap all other sites
Nuclear but clean. Every other connector that uses the daemon (USAA, Amazon, ChatGPT) also loses session, requiring re-auth. Heaviest user-interaction cost.

**Recommended:** Option B first (surgical, non-disruptive). If that fails, Option A for Chase specifically.

## Cross-cutting notes

- `pdpp-trust-model-framing.md` — the "device trust" concept is a real thing for banks; shared-profile architecture may not be viable for all institutions.
- `connector-configuration-open-question.md` — per-connector profile isolation is a missing capability in the current design.
