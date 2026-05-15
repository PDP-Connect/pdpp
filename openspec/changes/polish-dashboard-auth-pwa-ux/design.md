## Context

The dashboard runs as an operator surface for long connector jobs. A 12-hour placeholder owner session is safe but unnecessarily interrupts personal deployments that an operator uses across workdays. Hosted owner pages also ship their own CSS outside the Next.js theme runtime, so `/owner/login` was light-only even when the dashboard is dark.

## Decision

Set the reference placeholder owner-session default to 7 days and expose `PDPP_OWNER_SESSION_TTL_SECONDS` as the explicit override. This keeps the session finite and signed with the owner password-derived HMAC secret, while reducing routine re-authentication. Operators that need stricter posture can set a shorter TTL, force `Secure`, and use `SameSite=Strict`.

Add CSS-only dark-mode support to hosted owner pages with `prefers-color-scheme`. The owner login page is served by the reference server, not by the Next.js app, so it cannot read the dashboard theme cookie without coupling the forkable reference substrate to website-only theme state. OS preference is the correct low-coupling behavior.

## Tradeoff

A 7-day cookie increases the window in which a stolen browser cookie remains useful compared with 12 hours. The cookie remains HttpOnly and HMAC-signed; it is still reference-only placeholder auth, not a production IdP. The new env knob makes the tradeoff explicit and reversible.

## Acceptance Checks

- `/owner/login` follows OS dark mode without JavaScript and remains readable in light mode.
- Default owner-session `Max-Age` is 604800 seconds.
- `PDPP_OWNER_SESSION_TTL_SECONDS` accepts positive integer seconds and ignores invalid values.
- Existing dashboard PWA manifest remains the single source for install metadata and includes standalone dashboard start URL plus install icons.
