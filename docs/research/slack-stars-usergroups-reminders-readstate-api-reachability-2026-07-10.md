# Slack stars/user_groups/reminders/dm_read_states — API reachability audit

Status: decided, folded into OpenSpec change
`complete-slack-bundled-connector-coverage`.

Scope: read-only source inspection of `rusq/slackdump` and its `rusq/slack`
API-client dependency, plus Slack's public API reference docs. No Slack API
calls made, no credentials used, no personal record payloads read.

## Finding

The four Slack connector streams declared `coverage_policy: deferred` /
`availability.state: unsupported_in_mode` (`stars`, `user_groups`,
`reminders`, `dm_read_states`) are reachable with the credential the
connector already captures (`SLACK_TOKEN` xoxc session token +
`SLACK_COOKIE` `d` cookie). The "unsupported" claim was accurate about
slackdump's CLI surface (`slackdump list` only supports `users`/`channels`;
no CLI path calls `stars.list`, `usergroups.list`, `reminders.list`, or
reads `conversations.info` read-state fields) but not about source
availability: slackdump's own Go dependency `rusq/slack` (a
`slack-go/slack` fork) implements `ListStars`/`GetStarred`,
`GetUserGroups`, `ListReminders`, and `GetConversationInfo`
(`LastRead`/`UnreadCount`/`UnreadCountDisplay` fields), all authenticated via
the same `xoxc` token + `d` cookie pair slackdump itself uses
(`auth.NewValueAuth`, `auth/value.go`).

All four underlying Slack methods are documented, live, non-deprecated:

| Method | Tier | Source |
|---|---|---|
| `stars.list` | Tier 3 (50+ req/min) | <https://docs.slack.dev/reference/methods/stars.list> |
| `usergroups.list` | Tier 2 (20+ req/min) | <https://docs.slack.dev/reference/methods/usergroups.list> |
| `reminders.list` | Tier 2 (20+ req/min) | <https://docs.slack.dev/reference/methods/reminders.list> |
| `conversations.info` | Tier 3 (50+ req/min) | <https://docs.slack.dev/reference/methods/conversations.info> |

Tier table: <https://docs.slack.dev/apis/web-api/rate-limits/>. The 2025-05
tightening (<https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/>)
targets `conversations.history`/`conversations.replies`, not these four
methods.

## Full evidence trail

Commands, greps, and source excerpts:
`openspec/changes/complete-slack-bundled-connector-coverage/design-notes/slackdump-and-slack-api-capability-audit.md`.

## Implication

The Slack connector's manifest declarations for these four streams change
from an accepted-absence (`deferred`) to genuine collection (`collect`,
implemented via a small direct Slack Web API call path reusing the existing
session credential). See the OpenSpec change for implementation.
