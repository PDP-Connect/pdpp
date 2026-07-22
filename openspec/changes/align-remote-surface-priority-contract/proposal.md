## Why

`@opendatalabs/remote-surface` 1.x intentionally replaced host-specific lease priorities with `interactive` and `background`. PDPP makes that contract and its durable lease rows agree while consuming the published guarded `1.5.1` release across both importers.

## What Changes

- **BREAKING** Replace PDPP resource-priority values `owner_interactive` and `scheduled_refresh` with `interactive` and `background`.
- Migrate existing SQLite and Postgres lease rows and their check constraints during normal startup, while preserving priority ordering and serializing concurrent Postgres legacy startups before catalog discovery.
- Keep manual, scheduled, and webhook meaning in `triggerKind`; priority remains resource arbitration only.
- Align both importers at `^1.5.1` and prove the package-consumer retained-surface boundary against the installed published package.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: reference run admission and durable lease priority semantics.

## Impact

This affects runtime run options and scheduler/webhook callers, SQLite and Postgres browser-surface lease persistence, the published optional package range, and the remote-surface consumer boundary test.
