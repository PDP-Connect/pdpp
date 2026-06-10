## Why

ChatGPT conversations can be collected without messages, which advances the `conversations` cursor after emitting list-only parent rows. If `messages` are enabled later, older conversations can remain without child messages because the detail fetch reuses the already-advanced conversations cursor.

## What Changes

- Track ChatGPT message-detail progress independently from the conversations-list cursor.
- When `messages` are requested for the first time after a conversations-only run, backfill details for already-seen conversations instead of skipping them.
- Keep conversation records parent-first and emit bounded detail coverage before advancing the relevant state cursor.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: Connector detail collection must not reuse a parent stream cursor in a way that strands child records when a child stream is enabled later.

## Impact

- Affects the ChatGPT polyfill connector orchestration and tests.
- Adds no public API or dependency.
- Existing conversations-only state remains valid; message-detail collection performs the necessary one-time backfill on the next `messages` run.
