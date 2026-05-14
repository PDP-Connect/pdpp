## Why

ChatGPT collection now has enough live evidence that retry/backoff and serialized detail fetching are not sufficient by themselves. `run_1778776165021` still hit upstream pressure around `30/278` conversations with max detail concurrency `1`.

The February very-old ChatGPT connector likely completed large exports by tolerating per-conversation detail failures and returning placeholder conversations with `messages: []`. That avoided replay cost, but it silently converted required missing detail into apparently successful data.

Current PDPP bounded runs are more honest: failed required detail exhausts retries, the run fails, and the main cursor is not committed. That protects correctness, but it forces future attempts to replay the full uncommitted tranche even when list-level progress is already durable.

## What Changes

- Add a reference implementation design for connector detail-gap recovery.
- Allow a bounded run to commit list-level progress only when exhausted required detail failures are also recorded as explicit recoverable detail gaps/backlog entries.
- Require future runs to target recorded gaps before, or together with, ordinary forward list collection so missing detail can recover without replaying the full tranche.
- Preserve cursor honesty by prohibiting silent main-cursor advancement past required detail whose recovery state is not durable.
- Treat ChatGPT conversation detail hydration as the pilot, while keeping the capability general for connector sources with list-plus-detail collection.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Reference implementation only for the first tranche.
- Does not change the root PDPP protocol specs.
- Does not promote detail-gap backlog messages, tables, or `_ref` surfaces into Collection Profile requirements yet.
- Requires new durable reference storage for missing-detail gaps and recovery state during implementation.
- Requires deterministic tests proving cursor honesty, targeted recovery, and no silent lossy success.
