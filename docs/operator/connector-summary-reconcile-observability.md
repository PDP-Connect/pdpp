# Connector-summary reconciliation decision sample

`GET /_ref/connectors` keeps its existing observation barrier. The server logs a structured `connector summary reconcile observation` record after each barrier that repairs rows, fails, skips work, or is incomplete. Clean zero-repair barriers log deterministically once per 100 barriers in each server process. Each clean sample carries its cumulative `clean_barriers_since_epoch_lower_bound` and a non-identity `sampling_epoch_started_at`; a restart begins a new epoch and never carries prior volume forward. The record contains only aggregate counts, scope kind and size, duration, fixed candidate-reason classes, and a `resume_state`; it excludes owner identity, connection IDs, cursors, credentials, and raw errors.

## Seven-day production sample

1. Query the production structured-log sink for `observation="connector_summary_reconcile"` over seven consecutive UTC days.
2. Keep only `scope_kind="complete"` records. These are the barriers used by bare `GET /_ref/connectors` reads. Treat scoped records separately; they answer a different cost question.
3. Sum `repaired`, `failed`, and `skipped`. Count records with `incomplete=true`. For clean observations, group by `sampling_epoch_started_at`, take the largest `clean_barriers_since_epoch_lower_bound` from each epoch, then sum those maxima. This is the clean-volume lower bound; it intentionally excludes up to 99 clean barriers at the end of every observed epoch and every unobserved restart that never reached a sample. Add every exceptional record because those are unsampled.
4. Keep the raw clean `duration_ms` values. Sort ascending and calculate p95 by the nearest-rank method: at sample count `n`, take rank `ceil(0.95 * n)` (one-indexed). Do not extrapolate a cursor or any identity from these records; neither is logged.

## Decision threshold

Remove reconciliation from the bare list-read path only if the sample has at least 60 emitted clean latency samples, a clean-volume lower bound of at least 6,000 barriers, zero repaired rows, zero failed rows, zero skipped rows, zero incomplete barriers, and clean p95 is at least 100 ms by the nearest-rank method. The lower bound is deliberately conservative across process restarts; do not replace it with a sampled-volume estimate. Otherwise retain the barrier and use the reason-class, repair, and failure counts to choose a safer follow-up. This change does not alter reconciliation placement or user-visible behavior.
