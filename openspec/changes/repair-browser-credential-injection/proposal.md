## Why

Some active browser-backed account connections hold encrypted
`username_password` credentials, but the static-secret injection registry either
does not include the connector or expects an older credential shape. A run can
therefore fail with missing process env vars while a valid per-connection stored
credential sits unused. The owner-facing dashboard can then ask for reauth or
credential repair when the reference needs a runtime mapping fix.

## What Changes

- Add browser-backed username/password connectors to the static-secret injection
  registry: Amazon, Chase, USAA.
- Make Reddit's current runtime credential shape `username_password`, while
  accepting the old sealed bundle shape for already-stored rows.
- Extend scheduled/manual run tests and env-migration tests so active stored
  credentials prove they reach the connector child env.

## Impact

- Specs: `reference-connector-instances`.
- Code: `packages/polyfill-connectors/src/static-secret-injection.ts`,
  `reference-implementation/scripts/migrate-env-credentials.mjs`, and tests.
- No PDPP Core protocol change.
