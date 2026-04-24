# Connector Live-Smoke Status Matrix

Status: captured
Owner: connector-live-smoke-triage worker
Created: 2026-04-24
Updated: 2026-04-24
Related: openspec/changes/add-polyfill-connector-system

## Question

After the latest `main` runtime fixes, which first-party polyfill connectors are safe to retest, which need owner approval or the owner interaction, and which failures are code defects versus operator/session/upstream conditions?

## Context

This pass is static/code/runtime triage only. It did not run live authenticated syncs, did not start browser login flows, and did not attempt to automate around Cloudflare, Chase, or USAA anti-bot controls.

Inputs reviewed:

- `AGENTS.md`, `docs/agent-workstream-playbook.md`, `openspec/README.md`
- `openspec/changes/add-polyfill-connector-system/tasks.md`
- `packages/polyfill-connectors/CONNECTORS.md`
- `packages/polyfill-connectors/docs/authoring-guide.md`
- Connector code/manifests for GitHub, Gmail, Slack, Chase, YNAB, USAA, ChatGPT, and Claude Code
- Runtime/controller fixes on latest `main`
- Relevant regression tests for connector path resolution, composed internal-RS ingest, USAA login fallback, and connector parsers

## Stakes

The next live-smoke pass should avoid wasting the owner's attention. API/file-based connectors should be retested first where credentials/session state already exist. Browser-bank and Cloudflare-prone connectors should only be run in an owner-coordinated window with the right browser visibility and exact stop conditions.

## Current Leaning

Latest `main` fixed two reported runtime failures:

- GitHub `connector_protocol_violation` / `progress_for_undeclared_stream` for `commits` is expected fixed by `24541ed` (`runtime: resolve polyfill connector on connector_id collision`). The root cause was controller path resolution choosing the reference seed connector for a colliding GitHub `connector_id`, not the polyfill GitHub connector. Covered by `reference-implementation/test/connector-path-resolution.test.js`.
- Claude Code `/ingest/sessions` public-origin `500` is expected fixed by `2e4ac33` (`reference: route controller ingest to internal rs`). Covered by the first test in `reference-implementation/test/composed-origin.test.js`, which passed in this lane before a later unrelated web build failure.
- Dashboard/control-plane `Never run` summaries in pre-`bbc26a9` screenshots/logs are stale evidence. `bbc26a9` (`reference: fix connector run summary filtering`) fixed `_ref/connectors` run summaries by pushing `connectorId` into SQL run-correlation filtering instead of applying it after `limit: 1` pagination. After server restart, connector run summaries should reflect older connector runs even when newer runs from other connectors exist. Covered by `reference-implementation/test/control-actions.test.js`.

One narrow connector bug was fixed in this lane:

- `caa6842` (`polyfill: align ChatGPT 2FA interaction kind`) changes ChatGPT 2FA from invalid `INTERACTION kind="text_input"` to runtime-valid `kind="otp"` and reads the orchestrator's `data.code` response shape. This does not change protocol validation or manifest IDs/scope.

Control-plane interpretation rule:

- If evidence shows dashboard status `Never run` before `bbc26a9`, do not classify that as a connector failure. Re-check after server restart on `bbc26a9` or later using the connector detail page/run timeline.
- If `Never run` persists after restart on `bbc26a9` or later while run events exist for that connector, treat it as a control-plane regression, not as connector liveness evidence.

## Status Matrix

| Connector | Expected status after latest `main` | Static evidence | Auth/user action needed | Likely root cause for reported failure | Fix classification | Recommended next slice |
| --- | --- | --- | --- | --- | --- | --- |
| YNAB | Expected healthy; owner reported successful run with data | API connector; declared streams match code; progress emits only declared streams; `tasks.md` notes server_knowledge cursor is gap-free | Requires `YNAB_PERSONAL_ACCESS_TOKEN`; no the owner interaction if env exists | No current failure | Operator-approved live retest only, because it syncs personal finance data | Retest after server restart with existing env; verify `DONE succeeded`, record deltas, and state commit |
| GitHub | Expected fixed after `24541ed` | Polyfill connector emits progress only for `user`, `repositories`, `starred`, `issues`, `pull_requests`, `gists`; resolver test proves polyfill path wins over reference seed on manifest fingerprint | Requires `GITHUB_PERSONAL_ACCESS_TOKEN`/`GITHUB_TOKEN`; no the owner interaction if env exists | Previous failure was controller path-resolution collision executing reference seed connector, whose `commits` progress was undeclared by polyfill manifest | Code fixed on `main`; no connector source change needed | Retest with owner approval; if failure persists, capture run timeline and resolved connector path |
| Gmail | Needs cautious retest; diagnostics improved but root runtime failure not statically proven | Gmail has per-message error swallowing, stdout drain, BigInt/stringify hygiene, and process-level rejection handlers. `55aba6a` improves runtime ingest-response diagnostics, which should expose a concrete error if the generic `runtime_error` recurs | Requires `GMAIL_ADDRESS`/`GOOGLE_APP_PASSWORD_PDPP`; no the owner action if env exists | Reported failure after ~12k records and ~299 dropped buffered records could be RS ingest rejection, process/pipe termination, or server-side diagnostic now made visible by `55aba6a`; static code does not prove one cause | Unknown pending retest; likely runtime/ingest diagnostics first, not connector parser | Run a scoped incremental Gmail smoke with owner approval; capture terminal output and run timeline before making code changes |
| Slack | Status unknown; safe only with owner approval because slackdump may hit Slack API for hours | Connector wraps slackdump; README documents resume behavior and `PDPP_SLACK_SKIP_SLACKDUMP=1` archive-only escape hatch; declared-but-unavailable streams emit `SKIP_RESULT` intentionally | Requires `SLACK_WORKSPACE`, `SLACK_TOKEN`, `SLACK_COOKIE`, slackdump binary/archive; no the owner action if env/archive exists | Last report was "still running"; no failure shape available. Any old `Never run` dashboard state is stale if captured before `bbc26a9` | Operator/session/upstream until a terminal event is captured | First inspect current dashboard/run timeline after server restart; if no active run, use archive-only smoke before full slackdump resume |
| Chase | Auth succeeded, but dashboard account discovery is suspect | Code emits `SKIP_RESULT stream=accounts reason=selectors_pending` when `discoverAccounts(page)` returns empty, then returns success. The message is explicit: "No accounts discovered from dashboard. Selectors need calibration against live DOM." | Needs the owner/owner interactive Chase login and SMS OTP; browser should be visible (`browser.headless: false`) | Likely selector/scope issue or dashboard landed on a page not covered by `parseDashboardAccountsDom`; cannot prove without live DOM capture | Needs live DOM inspection; not safe to patch statically | Run in coordinated window with `PDPP_CAPTURE_FIXTURES=1`; if accounts still zero, stop after capturing DOM/screenshot and do not keep retrying |
| USAA | Expected to surface manual-action instead of failing invisibly; actual site access remains blocked/risky | `ea8e8b5`/current code catches `net::ERR_HTTP2_PROTOCOL_ERROR`, `ERR_CONNECTION_RESET`, and `ERR_FAILED` on login navigation and emits `manual_action`; test `ensureUsaaSession emits manual_action when USAA login navigation trips HTTP/2 bot failure` passes | Needs the owner/owner interactive USAA login and SMS OTP; may need visible browser or `xvfb`; credentials required | Upstream/network anti-bot/Akamai rejection of automated navigation; not a selector bug until login page loads | Operator/session/upstream; code fallback fixed | Do not brute-force. Run once in a coordinated visible-browser session; if navigation still fails, stop and capture browser/trace/logs |
| ChatGPT | Expected to request manual action for expired/Cloudflare sessions; 2FA interaction bug fixed in this lane | Browser fetch is intentionally via `page.evaluate(fetch)`; auto-login falls back to `manual_action` on unexpected UI/Cloudflare. `caa6842` fixes invalid `text_input` 2FA interaction and reads `data.code` | Needs the owner if session expired, Cloudflare appears, or 2FA is required; use visible browser | Reported "session expired/Cloudflare; no browser popped up" is expected if run was headless or interaction was surfaced only via file/drop dashboard, but 2FA branch also had an invalid interaction kind before `caa6842` | Mixed: one connector code bug fixed; remaining Cloudflare/session behavior is operator/session | Retest headed only with owner/the owner ready; if manual-action appears but no visible browser, capture interaction file/run page and stop |
| Claude Code | Expected fixed after `2e4ac33`; safe to retest after server restart with no external auth | File-based connector; latest code has compacted progress and recursive session traversal; composed-origin first regression test passed locally. Dashboard status should also be accurate after `bbc26a9` | No external credential or the owner action; reads local `~/.claude` files | Previous `/ingest/sessions` 500 was server-side runtime posting to public composed origin, not connector output volume. Pre-`bbc26a9` `Never run` status was control-plane filtering, not connector absence | Code fixed on `main`; residual risk is data volume/performance | Retest first after server restart; capture `run.completed`, sessions/messages counts, state streams committed, and connector summary status |

## Retest Buckets

### Safe to retest immediately after server restart, no user action needed

| Connector | Why | Suggested command/UI | Expected result | Capture |
| --- | --- | --- | --- | --- |
| Claude Code | Local file-based; no external auth or browser | Dashboard: Connectors -> Claude Code -> Run now. CLI equivalent: `node packages/polyfill-connectors/bin/orchestrate.js run claude_code` with the intended `PDPP_DB_PATH` | Run reaches `run.completed`; no `/v1/ingest/sessions` 500; `sessions`, `messages`, and `attachments` counts update; state commits; connector summary no longer incorrectly says `Never run` after `bbc26a9` server restart | Run page/timeline JSON, terminal output, record counts, connector summary card |

### Needs env credential already present, can run with owner approval

| Connector | Required env/tooling | Suggested command/UI | Expected result | Capture |
| --- | --- | --- | --- | --- |
| YNAB | `YNAB_PERSONAL_ACCESS_TOKEN` | Dashboard Run now or `node packages/polyfill-connectors/bin/orchestrate.js run ynab` | `DONE succeeded`; nonzero stream counts; cursor/state commits | Terminal output and run timeline |
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` or `GITHUB_TOKEN` | Dashboard Run now or `node packages/polyfill-connectors/bin/orchestrate.js run github` | No `commits` progress; no `progress_for_undeclared_stream`; run completes or fails only for auth/rate-limit | Run timeline; resolved connector path if failure recurs |
| Gmail | `GMAIL_ADDRESS`, `GOOGLE_APP_PASSWORD_PDPP` | Prefer a small owner-approved incremental run. Dashboard Run now or `node packages/polyfill-connectors/bin/orchestrate.js run gmail` | If failure recurs, runtime error should now include concrete ingest response diagnostics from `55aba6a` | Full terminal stderr/stdout tail, run timeline, failed event payload |
| Slack | `SLACK_WORKSPACE`, `SLACK_TOKEN`, `SLACK_COOKIE`, `slackdump` binary, archive path | First: inspect active run. If inactive, prefer `PDPP_SLACK_SKIP_SLACKDUMP=1 node packages/polyfill-connectors/bin/orchestrate.js run slack` to ingest existing archive only | Archive-only run completes or exposes parser/schema issue without hitting Slack API; full resume only with owner approval | Active run status, archive-only terminal output, `SKIP_RESULT`s |

### Needs the owner interactive action (OTP/browser/login/manual action)

| Connector | Exact test packet |
| --- | --- |
| Chase | Owner setup: use `/home/user/code/pdpp-connector-live-smoke`, ensure latest server is restarted on this branch or after merge, set `PDPP_CAPTURE_FIXTURES=1` for the run if possible. UI path: Dashboard -> Connectors -> Chase -> Run now. Expected prompt/browser behavior: visible Chase browser opens or is reused; Chase may ask for username/password and SMS OTP. the owner action: complete login and provide OTP through the run interaction/dashboard prompt. Capture: run page/timeline, terminal/browser-daemon logs, and the captured `dashboard-accounts` DOM if the connector emits `No accounts discovered from dashboard`. Stop condition: if OTP succeeds but accounts count is zero or `stream_skipped/accounts/selectors_pending` appears, stop; do not retry repeatedly. |
| USAA | Owner setup: run once only in a coordinated visible-browser window; do not run headless for triage. Suggested command if using CLI: `PDPP_USAA_HEADLESS=0 PDPP_TRACE=1 node packages/polyfill-connectors/bin/orchestrate.js run usaa`. UI path is acceptable if it guarantees a visible browser and run interactions. Expected prompt/browser behavior: if USAA login navigation trips HTTP/2/Akamai, connector emits `manual_action` explaining headed rerun; otherwise login page appears and may request SMS OTP. the owner action: complete login/OTP only once. Capture: run page/timeline, `/tmp/usaa-trace-*.zip` if written, browser-daemon logs, exact `manual_action` text. Stop condition: any `ERR_HTTP2_PROTOCOL_ERROR`, unusual activity page, or manual action that does not establish a session. |
| ChatGPT | Owner setup: use a headed run: `PDPP_CHATGPT_HEADLESS=0 node packages/polyfill-connectors/bin/orchestrate.js run chatgpt` or dashboard equivalent with visible browser. Expected prompt/browser behavior: browser opens to chatgpt.com/auth; Cloudflare may appear; 2FA now uses `INTERACTION kind=otp`. the owner action: complete Cloudflare/login in the visible browser; provide OTP in dashboard/terminal/file-drop if prompted. Capture: interaction request JSON path, run page/timeline, terminal output showing `manual_action` or `otp`, browser visibility. Stop condition: session remains inactive after manual action, Cloudflare loops, or no visible browser appears despite headed request. |

### Blocked by upstream/session/network and needs Playwright/DOM inspection

| Connector | Blocker | Inspection setup to recommend |
| --- | --- | --- |
| Chase | Account discovery returned zero after successful OTP; likely live DOM selector drift or dashboard scope/state mismatch | Dedicated owner/the owner session with `PDPP_CAPTURE_FIXTURES=1`, visible browser, and no repeated login retries. Inspect captured dashboard DOM and screenshot before code changes. |
| USAA | `net::ERR_HTTP2_PROTOCOL_ERROR` at login indicates upstream/Akamai/network rejection, not a parser failure | Dedicated visible Playwright session with `PDPP_TRACE=1`; if still rejected, stop and compare headed vs current environment logs. Do not automate around Akamai without owner decision. |
| ChatGPT | Cloudflare/session-expired path needs a human-visible browser if cookies are stale | Headed session with the owner present. If Cloudflare persists, treat as upstream/session, not connector parser. |

## Connector Test Packets

These packets are intended for the owner to coordinate with the owner. Do not run them unattended.

### GitHub

- Command/UI: Dashboard -> GitHub -> Run now, or `node packages/polyfill-connectors/bin/orchestrate.js run github`.
- Preconditions: `GITHUB_PERSONAL_ACCESS_TOKEN` or `GITHUB_TOKEN` is present in the environment used by the server/CLI.
- Expected behavior: progress streams are only `user`, `repositories`, `starred`, `issues`, `pull_requests`, or `gists`; no `commits` progress appears.
- Capture: run timeline failed/completed event, first 20 progress events, and any `connector_protocol_violation`.
- Stop condition: any `progress_for_undeclared_stream` means resolver path needs reinspection; capture resolved connector path before changing connector code.

### Gmail

- Command/UI: Dashboard -> Gmail -> Run now, or `node packages/polyfill-connectors/bin/orchestrate.js run gmail`.
- Preconditions: `GMAIL_ADDRESS` and `GOOGLE_APP_PASSWORD_PDPP` are present. Owner approval required because it syncs private mail.
- Expected behavior: per-message errors go to child stderr and the connector continues; if runtime ingest fails, latest runtime should expose concrete ingest response diagnostics.
- Capture: terminal output from `[gmail] main rejected`, child stderr, run timeline, `run.failed` payload, and count of dropped buffered records if present.
- Stop condition: first generic `runtime_error` without concrete diagnostics; do not patch Gmail until the actual response/body/status is known.

### Slack

- Command/UI: After restarting the server on `bbc26a9` or later, first inspect dashboard for active Slack run. Treat pre-`bbc26a9` `Never run` screenshots as stale. If inactive and owner approves archive-only smoke: `PDPP_SLACK_SKIP_SLACKDUMP=1 node packages/polyfill-connectors/bin/orchestrate.js run slack`.
- Preconditions: Slack env vars and slackdump archive exist.
- Expected behavior: archive-only run emits records or intentional `SKIP_RESULT`s for unsupported slackdump streams without hitting Slack API.
- Capture: whether an active run exists, slackdump archive path, terminal output, run timeline, and `SKIP_RESULT` list.
- Stop condition: if no archive exists or slackdump wants network refresh, stop for owner approval.

### YNAB

- Command/UI: Dashboard -> YNAB -> Run now, or `node packages/polyfill-connectors/bin/orchestrate.js run ynab`.
- Preconditions: `YNAB_PERSONAL_ACCESS_TOKEN` exists. Owner approval required because it syncs financial data.
- Expected behavior: successful run with stream states committed; no the owner action.
- Capture: terminal result, per-stream record counts, and state streams committed.
- Stop condition: auth failure or YNAB rate-limit; do not retry in a loop.

### Claude Code

- Command/UI: Dashboard -> Claude Code -> Run now, or `node packages/polyfill-connectors/bin/orchestrate.js run claude_code`.
- Preconditions: local Claude Code project directory is readable.
- Expected behavior: `run.completed`; ingest posts to internal RS, not public composed origin; no `/ingest/sessions` 500.
- Capture: run id, run timeline, terminal output, stream counts, and state commit.
- Stop condition: `/ingest/sessions` 500 or public-origin trap style failure; capture server mode/origins.

### Chase

- Command/UI: Dashboard -> Chase -> Run now with visible browser, preferably with `PDPP_CAPTURE_FIXTURES=1`.
- Preconditions: the owner available for Chase SMS OTP and any login prompt.
- Expected behavior: OTP prompt appears through dashboard/run interaction; after success, account discovery finds nonzero accounts.
- the owner action: enter Chase OTP once; do not repeatedly request codes.
- Capture: run page/timeline, interaction prompt, browser-daemon logs, `dashboard-accounts` capture, and any `stream_skipped/accounts/selectors_pending`.
- Stop condition: zero accounts, selector diagnostic, or unexpected dashboard page.

### USAA

- Command/UI: `PDPP_USAA_HEADLESS=0 PDPP_TRACE=1 node packages/polyfill-connectors/bin/orchestrate.js run usaa` or equivalent visible dashboard run.
- Preconditions: the owner available for USAA login/OTP; owner accepts a single bank-site attempt.
- Expected behavior: login page loads visibly or connector emits `manual_action` with HTTP/2 diagnostic.
- the owner action: complete login/OTP if page loads. If no visible browser exists, cancel/stop rather than continuing.
- Capture: run page/timeline, manual-action message, trace zip path, browser logs, exact navigation error.
- Stop condition: `ERR_HTTP2_PROTOCOL_ERROR`, unusual activity, manual action not establishing session, or repeated OTP requests.

### ChatGPT

- Command/UI: `PDPP_CHATGPT_HEADLESS=0 node packages/polyfill-connectors/bin/orchestrate.js run chatgpt`.
- Preconditions: the owner available for Cloudflare/login/2FA if needed.
- Expected behavior: visible browser; if 2FA appears, connector emits `INTERACTION kind=otp` and accepts `data.code`.
- the owner action: complete Cloudflare/login in the browser and provide OTP if prompted.
- Capture: visible-browser confirmation, interaction request/response files if used, run page/timeline, terminal output.
- Stop condition: no browser appears, Cloudflare loops, or session remains inactive after manual action.

## Decision Log

- 2026-04-24: Do not brute-force live connector tests without the owner. Static triage only for this lane.
- 2026-04-24: Treat GitHub as fixed by controller path resolution unless a retest shows the resolver still launches the reference seed connector.
- 2026-04-24: Treat Claude Code `/ingest/sessions` as fixed by internal-RS routing; retest first because it needs no external auth.
- 2026-04-24: Treat dashboard `Never run` evidence from before `bbc26a9` as stale control-plane evidence; after server restart, run summaries should filter by connector in SQL.
- 2026-04-24: Fixed ChatGPT's invalid 2FA interaction kind in connector code (`text_input` -> `otp`) and covered response-code extraction with a focused unit test.

## Promotion Trigger

Promote to an OpenSpec/runtime change only if retesting shows a durable contract gap: new interaction kinds, manifest-declared auth/session capabilities, structured partial-run recovery, or run-control behavior changes. Selector fixes and connector-specific auth handling should stay connector-local unless they expose a protocol/runtime mismatch.
