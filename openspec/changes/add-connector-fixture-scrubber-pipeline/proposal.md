## Why

The polyfill connector fleet needs real regression fixtures, but raw captures contain names, addresses, account details, order payloads, messages, and other private owner data. Synthetic fixtures are safer but miss real DOM/API drift. A disciplined scrubber pipeline is needed before real captures can become committed golden fixtures.

## What Changes

- Add a fixture capture and redaction pipeline for connector tests.
- Use deterministic regex and connector-specific rules where reliable.
- Add an LLM-assisted redaction pass for free-form personal data that simple regexes miss.
- Keep raw captures out of git and commit only reviewed scrubbed fixtures.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: first-party connector fixture policy becomes explicit and enforceable.
- `reference-implementation-architecture`: connector parser tests can depend on scrubbed real-shape fixtures without exposing owner secrets.

## Impact

- `packages/polyfill-connectors/bin/**`
- `packages/polyfill-connectors/connectors/*/fixtures/**`
- `packages/polyfill-connectors/connectors/*/scrub-rules.*`
- connector parser/integration tests
