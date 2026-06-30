# Amazon detail hydration root cause - 2026-06-26

Status: sanitized research closeout. This note preserves the durable connector
diagnosis from a scratch workstream report without retaining order identifiers,
detail URLs, local paths, or source payloads.

## Finding

The Amazon run failure was a slow detail-tail problem, not proof that the
connector could not read the account.

The run walked order-list pages and emitted many records before the controller
watchdog finalized it at the global four-hour limit. The expensive path was the
per-order detail lane: each order detail navigated to a detail page, waited for
known selectors, retried transient navigation or wait failures, and only then
emitted an honest detail gap. Repeated detail failures consumed enough wall time
to starve the rest of the run.

## Evidence preserved from the scratch report

- The inspected run reached the historical order walk before timeout.
- Hundreds of orders were processed.
- A small minority of order-detail attempts produced detail gaps.
- The failed-detail intervals were materially slower than ordinary list-page
  progress intervals.
- Existing fixture capture retained list-page evidence and a successful detail
  fixture, but not failed-detail DOM or screenshot evidence for the failed page
  class.

## Root-cause assessment

Most likely:

- repeated order-detail navigation or selector-wait timeouts;
- each retry-exhausted detail failure consumed much more time than a successful
  order-list row.

Plausible but not proven from the retained fixtures:

- Amazon redirected some order-detail URLs to a non-detail surface;
- a layout variant did not match the expected detail selectors;
- specific order classes hydrated slowly or incompletely.

Less likely:

- total account/session failure, because the run continued scanning order lists
  and emitted records before the watchdog finalized it.

## Fix direction captured

- Keep the global four-hour watchdog.
- Bound connector-local detail retries so repeated detail failures cannot consume
  the whole run.
- Preserve list-derived records and emit honest `DETAIL_GAP` /
  `DETAIL_COVERAGE` evidence.
- Capture one failed-detail checkpoint when fixture capture is enabled so future
  debugging can distinguish layout drift, non-detail redirects, source pressure,
  and transient source errors.
- Classify parser/layout failures separately from source-pressure failures so the
  scheduler does not apply the wrong cooldown semantics.
