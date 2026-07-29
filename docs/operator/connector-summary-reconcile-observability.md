# Connector-summary reconciliation decision sample

`GET /_ref/connectors` keeps its existing observation barrier. The server logs a structured `connector summary reconcile observation` record after each barrier that repairs rows, fails, skips work, or is incomplete. Clean zero-repair barriers log deterministically once per 100 barriers in each server process. The record contains only aggregate counts, scope kind and size, duration, fixed candidate-reason classes, and a `resume_state`; it excludes owner identity, connection IDs, cursors, credentials, and raw errors.

## Seven-day production sample

1. Query the production structured-log sink for `observation="connector_summary_reconcile"` over seven consecutive UTC days.
2. Keep only `scope_kind="complete"` records. These are the barriers used by bare `GET /_ref/connectors` reads. Treat scoped records separately; they answer a different cost question.
3. Sum `repaired`, `failed`, and `skipped`. Count records with `incomplete=true`. For clean observations, multiply the number carrying `zero_repair_sample_every=100` by 100 to estimate the complete-barrier count. Add every exceptional record because those are unsampled.
4. Calculate the repair rate as `sum(repaired) / estimated complete barriers`. Record p50 and p95 `duration_ms` from sampled clean records separately from repair/failure records. Do not extrapolate a cursor or any identity from these records; neither is logged.

## Decision threshold

Remove reconciliation from the bare list-read path only if the seven-day sample has at least 100 estimated complete barriers, zero repaired rows, zero failed rows, zero skipped rows, zero incomplete barriers, and the sampled clean-barrier p95 duration is at least 100 ms. Otherwise retain the barrier and use the reason-class, repair, and failure counts to choose a safer follow-up. This change does not alter reconciliation placement or user-visible behavior.
