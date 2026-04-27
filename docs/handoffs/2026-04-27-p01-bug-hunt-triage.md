# P0/P1 Bug Hunt Triage — 2026-04-27

Status: active triage
Owner: Codex owner loop

## Reports

- Auth/consent: `.claude/worktrees/p01-auth-consent/tmp/workstreams/p01-auth-consent-report.md`
- API/data: `.claude/worktrees/p01-api-data/tmp/workstreams/p01-api-data-report.md`
- Dashboard/mobile: `.claude/worktrees/p01-dashboard-mobile/tmp/workstreams/p01-dashboard-mobile-report.md`
- Docker/runtime: `.claude/worktrees/p01-docker-runtime/tmp/workstreams/p01-docker-runtime-report.md`
- Connectors/live: `.claude/worktrees/p01-connectors-live/tmp/workstreams/p01-connectors-live-report.md`

## Immediate Fix Lanes

1. `worktree-fix-device-code-exposure`
   - Severity: P0
   - Source: auth report P0-1/P0-2
   - Goal: `_ref` projections and spine timelines must not expose redeemable `device_code`, `user_code`, or `request_uri`.

2. `worktree-fix-sandbox-api-routes`
   - Severity: P0/P1
   - Source: dashboard/mobile report F1/F2
   - Goal: advertised sandbox API and well-known routes must return real mock responses.

3. `worktree-fix-docker-health-startup`
   - Severity: P0
   - Source: Docker/runtime report finding 1
   - Goal: Compose web must wait for reference AS/RS readiness rather than container start.

## Next Fix Lanes

- Consent UI trust/broadness:
  - Source: auth report P1-2, prior bug-hunt C3/C4/C6
  - Cover client-authored display provenance, wildcard expansion, continuous access risk, retention absence, AI-training typed consent.

- Connector maturity/honesty:
  - Source: connectors report P1-1/P1-2/P1-5
  - Cover stub/scaffolded connectors, stream-level unimplemented status, anti-bot budget for browser stubs.

- Runtime/semantic shutdown:
  - Source: Docker/runtime report findings 2 and 5
  - Cover backfill abort granularity, vec table recreation safety, clean SIGTERM.

- API aggregation pushdown:
  - Source: API/data report F2
  - Cover `aggregateRecords` SQL pushdown for resources/time_range to avoid large-corpus DoS behavior.

## Notes

- `_ref/*` read auth gating landed on main in `52b6ba2`.
- Sandbox rendered-route parity probe and `OverviewHero` leak fix landed on main in `9361979`.
- Treat all worker findings as evidence to review, not as automatically accepted truth.
