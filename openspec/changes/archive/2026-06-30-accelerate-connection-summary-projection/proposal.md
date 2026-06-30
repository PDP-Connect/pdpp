## Why

The owner console repeatedly reads the full connection-summary projection during one browser navigation. On the live Postgres instance, that projection is the shared hot path behind slow `/dashboard/runs` loads and can be fetched multiple times by RSC requests.

The same projection also assigned connector-scoped run evidence to every sibling connection. Repeated Amazon browser setup attempts therefore made multiple Amazon rows appear to share one run state, and Chase showed a failure from a different draft shell.

## What Changes

- Scope `last_run` and `last_successful_run` evidence to the exact connection when run events carry a browser-surface profile key or explicit connection identity.
- Surface browser-surface failure reason evidence from the run summary when no terminal `run.failed` event exists.
- Coalesce repeated full connection-summary reads on Postgres with a short-lived in-process single-flight cache.
- Reuse connector run summary pages per connector/status during one projection so sibling connections do not repeat the same run-page query.
- Preload retained-size connection/stream projection rows once per full-list projection instead of reading the retained-size stream/connection projections once per configured connection.
- Keep the full `/_ref/connectors` overview shallow for run summaries, while preserving deep run evidence on scoped connection/detail diagnostics.
- Add the live-proven Postgres source/run spine summary index to bootstrap so future instances do not regress the connection-summary hot path.
- Add a dependency-free Chrome/CDP browser performance harness so cold browser loads, RSC fetches, console errors, and RS/API latency are measured together.

## Capabilities

Modified:
- `reference-connector-instances`

## Impact

- Runtime: `reference-implementation/server/ref-control.ts`
- Runtime: `reference-implementation/server/postgres-storage.js`
- Tooling: `scripts/perf/browser-bench.mjs`
- Tests: connection-summary projection regression tests
- Operator UX: fewer misleading duplicate source states and lower repeated-RSC cost for pages that consume `/_ref/connectors`
