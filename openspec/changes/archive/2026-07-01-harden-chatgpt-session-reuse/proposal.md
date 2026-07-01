## Why

Live ChatGPT evidence showed a regression where an initially accepted browser session could fail on the first authenticated API fetch with `refresh_credentials`, and the runtime then closed the page that carried the only proven reusable auth state.

Later live evidence showed the next boundary: repeated scheduled runs succeeded while reusing one long-lived n.eko surface, then failed after deploy restarted that surface. The persistent profile kept Cloudflare/device cookies, but the authenticated ChatGPT session did not survive a fresh browser process.

## What Changes

- Preserve the ChatGPT run page after failed runs as well as successful runs.
- Keep the default browser-runtime behavior unchanged for other connectors.
- Prefer ChatGPT's current `/api/auth/session` access token before falling back to DOM bootstrap token extraction.
- Configure managed n.eko Chrome profiles to restore the previous browser session on startup, so session-cookie auth can survive container restarts.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- A failed ChatGPT collection no longer destroys a repairable authenticated page.
- Managed browser sessions can survive deploy/container restarts when the source stores auth in session cookies.
- Other browser-backed connectors continue to close failed pages unless they explicitly opt in.
