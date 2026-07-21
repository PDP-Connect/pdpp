---
title: "H-E-B account login supports passkeys and verification codes, and unauthenticated my-account traffic lands on an Incapsula-fronted OIDC login page; passive collection therefore needs a browser-session-first path plus an optional saved-sign-in-details repair path"
date: 2026-07-14
topic: connectors
tags: [heb, login, passkey, verification-code, incapsula, oidc, browser-session, credential-capture]
status: draft
sources: [heb-help-passkey, heb-help-passkey-fallback, heb-help-phone-code, heb-help-forgot-password, heb-help-new-account, heb-my-account-redirect]
---

## CLAIMS

- H-E-B's help pages confirm passkey support, including adding a passkey from account settings and using a passkey instead of a password or verification code. That means H-E-B login is not password-only, and any automation that claims to handle the whole login surface needs a browser-session handoff for passkey cases.
- H-E-B's help pages also document a 6-digit phone verification code flow for new or unrecognized devices, password problems, and phone-number updates. That is a manual challenge path, not a background-safe automatic login.
- The "forgot password" flow is email-code-driven and culminates in creating a new password. That is a distinct recovery path, not a hidden static-secret login API.
- A public unauthenticated visit to `https://www.heb.com/my-account/your-orders` redirected to an `accounts.heb.com/oidc/auth?...prompt=login...` URL and showed an Incapsula incident page. So the browser-bound entry point is real, and the login surface is protected by bot-challenge infrastructure.
- The right product model for PDPP is therefore two honest owner choices: session-only secure browser login, or saved encrypted sign-in details for automatic session repair.

## SOURCES

**heb-help-passkey**
URL: https://www.heb.com/help/account/how-do-i-add-a-passkey
Accessed: 2026-07-14

**heb-help-passkey-fallback**
URL: https://www.heb.com/help/account/if-i-add-a-passkey-can-i-still-use-a-password-or-code-to-log-in
Accessed: 2026-07-14

**heb-help-phone-code**
URL: https://www.heb.com/help/account/what-are-phone-verification-security-codes
Accessed: 2026-07-14

**heb-help-forgot-password**
URL: https://www.heb.com/help/account/i-forgot-my-password
Accessed: 2026-07-14

**heb-help-new-account**
URL: https://www.heb.com/help/account/how-do-i-create-a-new-account
Accessed: 2026-07-14

**heb-my-account-redirect**
URL: https://www.heb.com/my-account/your-orders
Observed on: 2026-07-14
Observed landing URL: https://accounts.heb.com/oidc/auth?client_id=...&prompt=login...

## SYNTHESIS

H-E-B behaves like a browser-bound, challenge-prone consumer account surface with a real identity-provider login front door. Passkeys and verification codes are first-class account recovery/login mechanisms, so a connector should not pretend the whole auth problem is "fill a password once and forget it." The operationally honest PDPP shape is:

1. probe and reuse a live browser session first,
2. if the session is dead, use encrypted sign-in details only when the owner opted into that path,
3. on passkey / code / CAPTCHA / Incapsula / unknown-UI cases, hand the browser to the owner and re-probe afterward,
4. never log or persist provider passwords in the browser/session layer.

That fits the existing browser-session lifecycle and lets the console present a generic dual choice for any browser-bound connector that also supports static-secret capture.
