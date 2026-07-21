## Context

The H-E-B connector is browser-bound and currently relies on a manual handoff when a session dies. Official H-E-B help pages confirm that:

- passkeys are supported,
- verification codes are used for login recovery / new-device login,
- password reset is email-code-driven, and
- the unauthenticated account flow redirects to an accounts.heb.com OIDC login page behind Incapsula.

That means the connector should not pretend sign-in is a purely static credential problem or a purely manual browser problem. It has two honest setup paths:

1. session-only secure browser login, and
2. saved sign-in details for automatic session repair.

The console should surface that choice generically from capability shape, not by naming H-E-B.

## Decision

### 1. Keep the browser-session lifecycle as the primary runtime seam

The browser-session connector lifecycle remains the source of truth for session repair and headed login handoff. H-E-B auto-login should:

- probe the live browser session first,
- if dead, attempt the verified login form only when encrypted credentials are present,
- prefer the verified login form when it is visible and enabled even if the page also advertises optional passkey or verification-code affordances,
- wait for a bounded post-submit page-state transition before any re-probe,
- handle verification-code pages through structured OTP before any browser handoff,
- and hand off to the secure browser on any passkey / CAPTCHA / Incapsula / unknown-UI / timeout / failed-login path.

The runtime must not store provider passwords in browser state or logs.

### 2. Treat H-E-B credential capture as an optional owner choice, not a new connector family

The manifest may declare static-secret capture because the implementation exists, but the connector remains browser-bound. The browser-session setup surface can offer a secondary "save sign-in details" path when the manifest has credential capture, while the primary path stays the secure browser login.

### 3. Derive the dual choice generically in the console

The console must not branch on connector keys. A browser-bound connector with static-secret capture should surface:

- a browser-session primary action, and
- an alternate saved-sign-in-details action.

Non-browser static-secret connectors keep their existing single-path static-secret setup.

### 4. Preserve the existing generic shell lifecycle

The browser-session shell creation, launch, recover, and rerun flow stays unchanged. The new behavior is in auth decisioning and setup presentation, not in the shell transport.

## Acceptance Checks

- H-E-B probe returns true for a live session and false for a dead one.
- H-E-B auto-login fills only the verified login form when credentials exist.
- H-E-B auto-login waits for a bounded post-submit transition before re-probing.
- H-E-B auto-login emits structured OTP for verification-code pages, fills and submits the code, re-probes, and hands off on passkey / CAPTCHA / Incapsula / unknown UI / timeout / failed submit.
- H-E-B manifest declares credential capture only after the implementation exists.
- Browser-bound connectors with static-secret capture surface both setup choices in the console.
- Non-browser static-secret connectors still surface only the static-secret path.
