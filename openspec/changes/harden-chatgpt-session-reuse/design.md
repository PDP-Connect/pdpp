## Context

The prior page-preservation change proved immediate ChatGPT session reuse, but it preserved the page only on successful runs. A later live run accepted the initial ChatGPT API session and then failed on `GET /memories` with `refresh_credentials`. Because the run failed, the runtime closed the page. Subsequent inspection showed only a placeholder browser page and zero durable ChatGPT cookies, which means teardown had removed the only proven reusable session surface.

## Decision

Add a narrow `BrowserConfig.preservePageOnFailure` runtime option. ChatGPT opts into it with `preservePageOnSuccess`; other connectors keep the existing cleanup semantics.

Also make ChatGPT token extraction prefer `/api/auth/session` before DOM bootstrap data. The initial auth probe already uses this endpoint to decide whether the session is active, so collection should use the same current session source before treating a 401 as a dead credential.

## Alternatives

- Preserve failed pages for every browser connector: rejected. Banking and commerce connectors should still clean up failed pages by default.
- Keep success-only preservation and rely on owner repair: rejected. It turns a collection-time auth refresh problem into repeated full login repair.
- Persist ChatGPT bearer tokens in connector state: rejected. It stores short-lived auth material outside the browser profile and does not solve server-side invalidation.

## Acceptance Checks

- Runtime tests prove failed-page preservation is opt-in and default cleanup remains unchanged.
- ChatGPT tests prove a 401 can re-extract a fresh token using the current session probe before failing terminally.
- Focused ChatGPT and runtime tests pass.
- Live validation after owner-attended repair proves immediate and one-hour reuse before schedules are re-enabled.
