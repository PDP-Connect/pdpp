## Context

The prior page-preservation change proved immediate ChatGPT session reuse, but it preserved the page only on successful runs. A later live run accepted the initial ChatGPT API session and then failed on `GET /memories` with `refresh_credentials`. Because the run failed, the runtime closed the page. Subsequent inspection showed only a placeholder browser page and zero durable ChatGPT cookies, which means teardown had removed the only proven reusable session surface.

After that tranche, live runs proved two more boundaries. First, a scheduled run can see a visually logged-in ChatGPT shell while the API session probe is false (`api_session_user=false`); the connector must treat the API session as authoritative for collection. Second, a manual owner repair and an immediate follow-up run succeeded on the same n.eko surface (`api_session_user=true`), but a forced n.eko container restart lost the authenticated ChatGPT API session even with the persistent profile and `RestoreOnStartup` policy. The persisted Chrome profile still held ChatGPT Cloudflare/device cookies, but not a usable API session. The failure was therefore not a profile-key mapping bug and not a missing bind mount; it was the gap between live browser-process auth and restart-restored auth.

The live repair also exposed an owner-flow gap. The post-submit login fallback emitted blocking `INTERACTION manual_action`; after the owner completed login in the streaming companion, the run still waited for an explicit interaction success response before re-checking the session. That contradicted the operator copy and the push-approval path, which already used non-blocking assistance plus readiness polling.

The first deployed no-response assistance run exposed the companion-page half of the same contract. The runtime emitted `run.assistance_requested` with `owner_action=operate_attachment`, `response_contract=none`, and a `browser_surface` attachment, but the stream page treated browser-surface assistance as streamable only when a response was required. The owner saw "No browser action is waiting" while the live browser still needed login.

## Decision

Add a narrow `BrowserConfig.preservePageOnFailure` runtime option. ChatGPT opts into it with `preservePageOnSuccess`; other connectors keep the existing cleanup semantics.

Also make ChatGPT token extraction prefer `/api/auth/session` before DOM bootstrap data. The initial auth probe already uses this endpoint to decide whether the session is active, so collection should use the same current session source before treating a 401 as a dead credential.

Configure the managed n.eko Chrome policy with `RestoreOnStartup: 1`. The reference image already binds a persistent `--user-data-dir`; this policy makes that claim true for sources whose actual auth lives in browser session state. This is global to managed n.eko surfaces rather than ChatGPT-specific because USAA and other browser-backed connectors can use session cookies for real auth too, and the browser profile is already the intended isolation boundary.

Make ChatGPT post-submit browser-login fallback match the push-approval path: emit non-blocking `ASSISTANCE` with a browser-surface attachment, poll the ChatGPT API session probe, resolve the assistance and continue when the session becomes active, and use blocking `INTERACTION manual_action` only after the bounded observation window is exhausted. This is ChatGPT-specific at the readiness-probe layer, but uses the existing connector-runtime assistance protocol.

Make the dashboard stream projection honor the same structured assistance contract. Browser-surface assistance is streamable whenever the owner action is `operate_attachment` and a browser-surface attachment is available, regardless of whether the response contract is `response_required` or `none`. The stream viewer renders submit/continue controls only for response-required assistance. For no-response browser assistance, the owner can operate the live browser while the connector keeps polling for completion.

## Alternatives

- Preserve failed pages for every browser connector: rejected. Banking and commerce connectors should still clean up failed pages by default.
- Keep success-only preservation and rely on owner repair: rejected. It turns a collection-time auth refresh problem into repeated full login repair.
- Persist ChatGPT bearer tokens in connector state: rejected. It stores short-lived auth material outside the browser profile and does not solve server-side invalidation.
- Add a ChatGPT-specific credential/session-token store: rejected. It creates a second credential authority when the browser profile is already the intended credential boundary.
- Keep profiles persistent but do not restore browser session state: rejected. It only works until a restart; `RestoreOnStartup` improves tab restoration, but live evidence shows it is not sufficient by itself for ChatGPT API-session survival.
- Require the owner to click a "done" control after completing ChatGPT browser login: rejected for the primary path. The connector can directly observe the authoritative session probe and should resume without a redundant owner acknowledgment. A blocking manual action remains as an escalation fallback when the probe never becomes active.
- Treat `response_contract=none` browser assistance as passive timeline copy only: rejected. It hides the very browser surface the owner must operate.

## Acceptance Checks

- Runtime tests prove failed-page preservation is opt-in and default cleanup remains unchanged.
- ChatGPT tests prove a 401 can re-extract a fresh token using the current session probe before failing terminally.
- n.eko image-policy tests prove managed Chrome restores the prior browser session on startup.
- ChatGPT tests prove post-submit browser-login assistance auto-resumes without an `INTERACTION` response when the API session becomes active.
- Dashboard tests prove no-response browser-surface assistance opens the streaming companion without rendering a submit/continue control.
- Focused ChatGPT and runtime tests pass.
- Live validation after owner-attended repair proves immediate no-owner-action reuse before closing the change.
- Post-restart ChatGPT API-session survival is a residual risk unless a later change introduces a provider-supported credential/session authority beyond the browser process.
