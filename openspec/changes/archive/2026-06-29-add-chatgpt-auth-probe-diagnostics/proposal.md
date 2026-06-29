## Why

ChatGPT scheduled runs now surface app-approval prompts after stored credentials are injected. Existing run artifacts cannot determine whether the connector re-entered login because the session was genuinely not accepted or because the initial probe was too narrow. The current first checkpoint captures `about:blank`; later auth captures happen after password submission.

## What Changes

- Add a ChatGPT-specific, privacy-bounded auth-probe diagnostic before credential login.
- Keep the current auth decision unchanged.
- Record only route class and boolean probe signals, never DOM, screenshots, cookies, titles, credentials, or conversation content.

## Capabilities

Modified:
- `reference-implementation-runtime`

## Impact

- Future ChatGPT auth runs become diagnosable without requiring a broad live-debug session.
- No connector auth behavior changes in this tranche.
- No grant-scoped or MCP surface changes.
