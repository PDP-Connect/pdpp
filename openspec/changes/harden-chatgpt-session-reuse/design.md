## Context

The prior page-preservation change proved immediate ChatGPT session reuse, but it preserved the page only on successful runs. A later live run accepted the initial ChatGPT API session and then failed on `GET /memories` with `refresh_credentials`. Because the run failed, the runtime closed the page. Subsequent inspection showed only a placeholder browser page and zero durable ChatGPT cookies, which means teardown had removed the only proven reusable session surface.

After that tranche, live runs proved a second boundary. A manual owner repair and two scheduled ChatGPT runs succeeded while reusing the same long-lived n.eko surface (`api_session_user=true`). The next scheduled run after a deploy created a fresh surface on the same profile path and failed (`api_session_user=false`). The persisted Chrome profile still held ChatGPT Cloudflare/device cookies, but not an authenticated API session cookie. The failure was therefore not a profile-key mapping bug and not a missing bind mount; it was the gap between live browser-process auth and restart-restored auth.

## Decision

Add a narrow `BrowserConfig.preservePageOnFailure` runtime option. ChatGPT opts into it with `preservePageOnSuccess`; other connectors keep the existing cleanup semantics.

Also make ChatGPT token extraction prefer `/api/auth/session` before DOM bootstrap data. The initial auth probe already uses this endpoint to decide whether the session is active, so collection should use the same current session source before treating a 401 as a dead credential.

Configure the managed n.eko Chrome policy with `RestoreOnStartup: 1`. The reference image already binds a persistent `--user-data-dir`; this policy makes that claim true for sources whose actual auth lives in browser session state. This is global to managed n.eko surfaces rather than ChatGPT-specific because USAA and other browser-backed connectors can use session cookies for real auth too, and the browser profile is already the intended isolation boundary.

## Alternatives

- Preserve failed pages for every browser connector: rejected. Banking and commerce connectors should still clean up failed pages by default.
- Keep success-only preservation and rely on owner repair: rejected. It turns a collection-time auth refresh problem into repeated full login repair.
- Persist ChatGPT bearer tokens in connector state: rejected. It stores short-lived auth material outside the browser profile and does not solve server-side invalidation.
- Add a ChatGPT-specific credential/session-token store: rejected. It creates a second credential authority when the browser profile is already the intended credential boundary.
- Keep profiles persistent but do not restore browser session state: rejected by live evidence; it only works until the container restarts.

## Acceptance Checks

- Runtime tests prove failed-page preservation is opt-in and default cleanup remains unchanged.
- ChatGPT tests prove a 401 can re-extract a fresh token using the current session probe before failing terminally.
- n.eko image-policy tests prove managed Chrome restores the prior browser session on startup.
- Focused ChatGPT and runtime tests pass.
- Live validation after owner-attended repair proves immediate, one-hour, and post-restart reuse before closing the change.
