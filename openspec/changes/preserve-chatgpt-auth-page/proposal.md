## Why

ChatGPT app approval can establish an authenticated page state that is usable for collection but not durable in the Chromium cookie store. The browser runtime currently opens a fresh page and closes it after every successful connector run. For ChatGPT, that discards the only state that avoids another owner app-approval prompt on the next run.

## What Changes

- Add an opt-in browser-runtime policy that reuses an existing non-blank page for a connector run.
- Preserve the run page after successful runs only when the connector opts in.
- Keep the existing close-on-success behavior for all default browser connectors.
- Have the ChatGPT connector opt in to the preserved-page policy.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Reduces repeated ChatGPT owner-interaction prompts when the source keeps useful auth state in the live page rather than persistent cookies.
- Limits risk by preserving pages only after successful runs and only for opted-in connectors.
- Does not change browser acquisition, profile selection, tracing, fixture capture, or session-establishment semantics.
