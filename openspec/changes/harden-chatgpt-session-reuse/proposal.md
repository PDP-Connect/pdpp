## Why

Live ChatGPT evidence showed a regression where an initially accepted browser session could fail on the first authenticated API fetch with `refresh_credentials`, and the runtime then closed the page that carried the only proven reusable auth state.

## What Changes

- Preserve the ChatGPT run page after failed runs as well as successful runs.
- Keep the default browser-runtime behavior unchanged for other connectors.
- Prefer ChatGPT's current `/api/auth/session` access token before falling back to DOM bootstrap token extraction.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- A failed ChatGPT collection no longer destroys a repairable authenticated page.
- Other browser-backed connectors continue to close failed pages unless they explicitly opt in.
