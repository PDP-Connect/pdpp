## Why

The Slack connector manifest declares four streams (`stars`, `user_groups`,
`reminders`, `dm_read_states`) as `coverage_policy: deferred` with
`availability.state: unsupported_in_mode`, reasoning that slackdump's
archive mode never calls the corresponding Slack methods. That reasoning is
accurate for slackdump, but slackdump is not the only substrate the
connector already holds: the captured credentials (`SLACK_TOKEN` xoxc
session token + `SLACK_COOKIE` `d` cookie) are a full Slack Web API session,
not merely a slackdump input. All four underlying methods
(`stars.list`, `usergroups.list`, `reminders.list`,
`conversations.info` for DM read state) are live, documented, non-deprecated
Slack Web API methods that accept this same session credential — confirmed
by reading `rusq/slack` (the Go client slackdump itself depends on), which
implements all four, and by each method's Slack API reference page (see
`design-notes/slackdump-and-slack-api-capability-audit.md`).

"Not realizable from a slackdump archive" is true and irrelevant: it was
never a statement about source-side availability, only about one tool's CLI
surface. Declaring these `deferred` as permanent steady-state, when the
connector already holds a credential that can call the real endpoints,
misrepresents an implementation gap as a source limitation.

## What Changes

- Add a small direct Slack Web API call path to the Slack connector, reusing
  the existing `SLACK_TOKEN`/`SLACK_COOKIE` credential and the shared
  `createConnectorHttpGovernor` retry/pacing pattern already used by
  `github`/`ynab`. No new auth modality, no manifest `setup` change.
- Implement `stars`, `user_groups`, and `reminders` end-to-end: call
  `stars.list`, `usergroups.list`, `reminders.list`; parse; validate;
  emit RECORD/STATE per the existing per-stream schema.
- Implement `dm_read_states` via `conversations.info`, scoped to channels
  the archive already marked `is_im`/`is_mpim` (bounding call volume to
  actual DM/MPIM channels, not the full channel inventory).
- Flip all four streams' manifest declarations from
  `coverage_policy: deferred` / `availability.state: unsupported_in_mode`
  to `coverage_policy: collect` (drop `availability`) now that they are
  genuinely collected.
- Add a `slackApiPacingProfile()` to `provider-profile.ts`, derived from the
  binding (slowest) documented tier across the four methods used
  (Tier 2, 20+ req/min → `usergroups.list`/`reminders.list`).
- Fixtures + tests for the new call path (success, empty, 429, auth
  failure) and for the parser/schema changes; update `slackdump-runtime.test.ts`
  fixtures that assert the old `unsupported_in_mode` SKIP_RESULT for these
  four streams.
- Update `packages/polyfill-connectors/connectors/slack/README.md` to
  correct the stale claim that `dm_read_states` is already emitted, and to
  describe the new direct-API stream path alongside the slackdump-archive
  path.

No streams in this change turn out to be genuinely inaccessible from the
existing credential; there is no residual `unsupported`/`unavailable`
disposition to declare after implementation. If live verification later
proves a method blocked (e.g. workspace admin restricts a legacy endpoint
for locked-down workspaces), that is a connection-level runtime failure to
handle via `SKIP_RESULT`/retry, not a manifest-level unavailability claim.

## Capabilities

- Modified: `polyfill-runtime` — the `coverage_policy` requirement gains a
  durable rule that a wrapped tool's CLI gap is not sufficient grounds for
  a `deferred`/`unsupported`/`unavailable` declaration when the connector's
  own credential can reach the source directly, plus a Slack-specific
  scenario naming the four streams this change moves to `collect`.

## Impact

- `packages/polyfill-connectors/connectors/slack/index.ts`,
  `parsers.ts`, `schemas.ts`, `types.ts`
- `packages/polyfill-connectors/manifests/slack.json`
- `packages/polyfill-connectors/src/provider-profile.ts`
- `packages/polyfill-connectors/connectors/slack/README.md`
- New/updated fixtures and tests under
  `packages/polyfill-connectors/connectors/slack/__fixtures__/` and
  `*.test.ts`

## Residual Risks

- Live-credential verification (a real workspace, real `xoxc`/`d` cookie,
  confirming each of the four endpoints returns real data end-to-end
  through the reference stack) is owner-only and out of scope for this
  change; implementation is verified here via unit tests against captured
  response shapes from Slack's public API reference and `rusq/slack`'s
  response structs.
- `conversations.info` on legacy/free workspaces or workspaces with admin
  restrictions on session-token API access could still return an
  auth/scope error at runtime; the connector treats that as a retryable or
  terminal runtime failure (existing `retryablePattern`/SKIP_RESULT
  machinery), not a manifest-level unavailability, since the failure is
  connection-specific rather than universal to the source.
