## Context

The dashboard home needs a small "what has been read" list and the runs page
needs a recent run list. Those are overview reads. Before this change, Postgres
computed them by grouping every matching `spine_events` row, sorting the full
aggregate, then hydrating each summary sequentially.

Live evidence:

- `/_ref/traces?limit=6`: about 365-900ms after warmup.
- `/_ref/runs?limit=100`: about 700-950ms after warmup.
- `EXPLAIN ANALYZE` for seven traces grouped 579,502 events and took about
  1.1s even with an index-only scan.

## Decisions

### 1. Recent first pages use recent-event scans

For an unfiltered first page, the newest correlation groups can be found by
scanning events by `occurred_at DESC` until `limit + 1` distinct correlation IDs
are found and timestamp ties at the boundary are consumed. The selected IDs are
then aggregated and hydrated. This avoids grouping the whole table to show a
small recent page.

### 2. Filters and cursors keep the old aggregate path

The recent scan path is intentionally limited to first-page overview reads with
no status, time, source, grant, client, cursor, or query filter. Filtered and
paginated reads keep the existing aggregate semantics.

### 3. Page hydration is bounded-concurrent

Once a page of correlation IDs is selected, hydration is independent per ID. The
Postgres implementation hydrates those rows with bounded concurrency so a
100-run page does not spend one network/DB round trip after another.

### 4. Dashboard home does not fetch unused failure lists

The dashboard hero now derives "needs you" from connector rendered verdicts, not
failed runs or failed traces. The page SHALL NOT block on failed-run/failed-trace
lists it no longer renders.

## Alternatives

- Materialized spine summary table: likely a future improvement if the event
  spine grows by another order of magnitude, but higher-risk than a first-page
  read optimization because it changes write paths and invalidation.
- Approximate recent traces with a fixed top-N subquery only: rejected. The
  implemented scan continues until it has enough distinct IDs and consumes the
  boundary timestamp, then falls back to the aggregate path if it must scan too
  far.
- Remove the "what has been read" block from the dashboard: rejected. The owner
  promise includes knowing what has been read; the fix is to make the overview
  read cheap, not to hide it.

## Acceptance Checks

- Unfiltered first-page `/_ref/traces`, `/_ref/runs`, and `/_ref/grants` still
  return the existing list envelope shape.
- Filtered and cursor-paginated spine list reads still use the existing aggregate
  semantics.
- Reference and console type checks pass.
- Live proof after deploy: authenticated `/_ref/traces?limit=6`,
  `/_ref/runs?limit=100`, `/dashboard`, and `/dashboard/runs` improve without
  console/page errors.
