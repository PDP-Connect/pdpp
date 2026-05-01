## Why

The reference already emits `freshness` objects, but the primary builder reports `status: "unknown"` even when run history and refresh-policy data can support a stronger answer. It also uses record `last_updated` as `last_attempted_at`, which conflates data capture with refresh attempts. Owners and clients need an honest answer to "how fresh is this data?" without treating freshness as a grant guarantee.

## What Changes

- Introduce one shared freshness derivation rule for RS query responses and reference control-plane summaries.
- Derive `captured_at` from the latest successful connector run when run history exists; fall back to record `last_updated` only when no run history is available.
- Derive `last_attempted_at` from the latest run attempt, not from record timestamps.
- Promote `status` to `current` or `stale` only when the connector declares `capabilities.refresh_policy.maximum_staleness_seconds` or the latest attempt failed; otherwise keep `unknown`.
- Keep request-refresh and public event subscriptions out of scope. This change only makes existing freshness fields honest.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: define reference freshness derivation semantics for already-shipped RS and `_ref` surfaces.

## Impact

- `reference-implementation/server/freshness.ts` or equivalent shared helper.
- `reference-implementation/server/index.js` stream, schema, and stream-detail freshness wiring.
- `reference-implementation/server/ref-control.ts` connector summary/detail freshness wiring.
- Targeted tests for current, stale, failed-attempt, and unknown-no-policy cases.
- `apps/web/content/docs/spec-core.md` freshness text if implementation details need clarification.
