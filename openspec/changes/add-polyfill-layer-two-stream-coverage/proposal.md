## Why

`add-polyfill-connector-system` has become a mixture of shipped MVP infrastructure, live connector bug notes, and a large Layer 2 stream backlog. That makes it hard for workers to improve connector coverage without touching unrelated runtime or governance work.

## What Changes

- Split high-value stream additions and account-data cleanup into a dedicated Layer 2 coverage change.
- Treat Spotify and Reddit local rows as untrusted demo/seed data until purged and replaced by verified real-account ingestion.
- Add connector-specific tasks for ChatGPT, Claude Code, Codex, GitHub, YNAB, USAA, Gmail, Slack, Reddit, and Spotify where the existing backlog identifies missing high-value streams.
- Keep runtime protocol, scheduler, fixture-scrubber, and partial-run semantics out of this change.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: first-party polyfill connector coverage becomes a deliberate, provenance-honest reference capability rather than an undifferentiated backlog list.

## Impact

- `packages/polyfill-connectors/connectors/**`
- `packages/polyfill-connectors/manifests/**`
- `openspec/changes/add-polyfill-connector-system/tasks.md`
- connector-specific tests and fixtures
