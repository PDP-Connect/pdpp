## MODIFIED Requirements

### Requirement: Reference spine overview lists are bounded on Postgres

The reference implementation SHALL serve unfiltered first-page reference spine
correlation lists (`/_ref/traces`, `/_ref/runs`, and `/_ref/grants`) from a
bounded recent-correlation read path on Postgres. Filtered and cursor-paginated
reads SHALL preserve the existing aggregate semantics.

#### Scenario: recent first page avoids whole-table grouping

**WHEN** the owner reads the first page of traces, runs, or grants with no
filters and no cursor
**THEN** the Postgres implementation uses a recent-event scan to select the page
of correlation IDs
**AND** it hydrates only the selected page.

#### Scenario: filtered reads keep aggregate semantics

**WHEN** the owner reads a spine correlation list with a status, time, source,
grant, client, query, or cursor filter
**THEN** the Postgres implementation uses the aggregate path that applies those
filters to the correlation semantics
**AND** it does not silently substitute the unfiltered recent path.

### Requirement: Dashboard home does not block on unused operational lists

The console SHALL NOT fetch failed-run or failed-trace lists on the dashboard
home when those lists do not drive any rendered hero, card, or action.

#### Scenario: dashboard attention truth comes from connector verdicts

**WHEN** the dashboard home renders the "needs you" hero state
**THEN** it derives that state from connector rendered verdict attention rows
**AND** it does not fetch failed-run or failed-trace lists for that decision.
