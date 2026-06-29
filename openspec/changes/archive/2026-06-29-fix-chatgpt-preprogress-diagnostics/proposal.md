## Why

ChatGPT connector failures before authenticated collection can reach the reference runtime as `DONE status="failed"` with only the generic terminal reason `connector_reported_failed`.

## What Changes

- Preserve safe, durable failure metadata for ChatGPT pre-auth and pre-progress failures.
- Map expired or invalid sessions to a known gap with `refresh_credentials`.
- Map visible login/challenge failures to manual-action assistance metadata.
- Keep parser and runtime exceptions bounded and non-secret.

## Capabilities

Modified:
- `reference-implementation-runtime`

## Impact

- Affected code: `packages/polyfill-connectors/src/connector-runtime.ts`, `packages/polyfill-connectors/connectors/chatgpt/index.ts`
- Affected tests: ChatGPT connector integration tests and reference-runtime terminal known-gap behavior
