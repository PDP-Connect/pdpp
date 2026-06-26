## Context

The runtime already persists terminal known gaps when a failed connector supplies `DONE.error.message`. The ChatGPT connector can fail before any authenticated collection progress, and the top-level terminal reason remains the generic `connector_reported_failed`.

## Decision

Add a connector-scoped terminal error normalizer. The shared runtime stays generic; ChatGPT opts in and rewrites only bounded public error text before emitting `DONE`.

The normalizer keeps the existing `DONE.error` wire shape. It does not add durable secrets or raw page payloads.

## Scope

In scope:
- ChatGPT pre-auth and pre-progress terminal failures.
- Safe messages that downstream known-gap classification can use.
- Tests proving a simulated pre-progress failure has non-empty known gaps and is not only a bare generic terminal reason.

Out of scope:
- Other connectors.
- Live credential checks.
- Deployment or scheduler changes.

## Acceptance Checks

- `openspec validate fix-chatgpt-preprogress-diagnostics --strict`
- ChatGPT connector tests cover auth invalidation, visible login/challenge, and parser/runtime exception normalization.
- Reference runtime tests cover terminal known-gap persistence for a simulated ChatGPT pre-progress failure.
