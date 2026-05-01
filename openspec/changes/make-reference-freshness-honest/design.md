## Context

Freshness is observable server metadata. It is not a grant constraint and it does not promise source state has not changed. The reference should still report the strongest defensible state it can derive from local runtime evidence.

Current behavior has two weak spots:

- `status` is always `unknown`, including for connectors with recent successful runs and explicit `maximum_staleness_seconds`.
- `last_attempted_at` is copied from record `last_updated`, which is not a refresh attempt and can be unchanged after successful "no new data" runs.

The existing scheduler/run surfaces already track the inputs we need: latest run attempt, latest successful run, and connector refresh policy.

## Derivation

Inputs:

- `lastSuccessfulRunAt`: latest completed successful connector run, if known.
- `lastAttemptedAt`: latest connector run attempt, including failed/cancelled attempts, if known.
- `lastAttemptStatus`: latest run status, if known.
- `recordLastUpdatedAt`: latest record update for fallback only.
- `maximumStalenessSeconds`: connector `capabilities.refresh_policy.maximum_staleness_seconds`, if declared.
- `now`: request-time clock.

Rules:

1. `captured_at` is `lastSuccessfulRunAt` when known, otherwise `recordLastUpdatedAt` when known, otherwise omitted.
2. `last_attempted_at` is `lastAttemptedAt` when known, otherwise omitted.
3. If the latest attempt failed or was cancelled after the latest success, `status` is `stale`.
4. If `maximumStalenessSeconds` is absent, `status` is `unknown` unless rule 3 applies.
5. If `captured_at` is present and age is `<= maximumStalenessSeconds`, `status` is `current`.
6. If `captured_at` is present and age is `> maximumStalenessSeconds`, `status` is `stale`.
7. If no capture evidence exists, `status` is `unknown`.

The reference should not invent default staleness thresholds for connectors that do not declare one.

## Scope

In scope:

- Shared derivation helper with pure unit tests.
- Native RS `/v1/schema`, `/v1/streams`, and `/v1/streams/{stream}` freshness wiring.
- `_ref/connectors` and `_ref/connectors/{id}` summary/detail freshness wiring.
- Sandbox fixture parity using deterministic fixture time where the sandbox emits freshness.

Out of scope:

- Public `request_refresh` endpoint or query parameter.
- Grant-scoped webhooks, SSE, or event subscriptions.
- Promoting `refresh_policy` to PDPP Core.
- Dashboard redesign beyond consuming the corrected fields already present.

## Acceptance

- A connector with a successful run inside `maximum_staleness_seconds` emits `status: "current"`.
- A connector with a latest failed attempt after the latest success emits `status: "stale"` and includes `last_attempted_at`.
- A connector with record data but no run history keeps `status: "unknown"` and does not fabricate `last_attempted_at`.
- A connector without `maximum_staleness_seconds` keeps `status: "unknown"` unless the latest attempt failed after the latest success.
- RS and `_ref` surfaces use the same helper for equivalent inputs.
