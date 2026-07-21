**Status:** decided — folded into `../design.md` §Evidence and §Decision 1/4
**Raised:** 2026-07-10
**Context:** determining whether the four `coverage_policy: deferred` Slack
streams (`stars`, `user_groups`, `reminders`, `dm_read_states`) are actually
unreachable from the source, or only unreachable via slackdump's CLI.

## Question

Does the credential the Slack connector already captures (`SLACK_TOKEN`
xoxc session token + `SLACK_COOKIE` `d` cookie) permit calling
`stars.list`, `usergroups.list`, `reminders.list`, and
`conversations.info` (for read-state fields) directly against Slack's Web
API, bypassing slackdump's archive-mode limitation?

## Method

Read-only source inspection. No Slack API calls were made, no credentials
were used, no personal record payloads were read. Two repos cloned
disk-backed (`~/.tmp`, not `/tmp`) for inspection:

```bash
mkdir -p ~/.tmp/slackdump-probe && cd ~/.tmp/slackdump-probe && \
  git clone --depth 1 https://github.com/rusq/slackdump.git .

mkdir -p ~/.tmp/rusq-slack-probe && cd ~/.tmp/rusq-slack-probe && \
  git clone --depth 1 https://github.com/rusq/slack.git .
```

## Findings

### 1. slackdump's CLI has no subcommand for these four capabilities

```bash
cd ~/.tmp/slackdump-probe
grep -rln "stars.list\|StarsList\|usergroups.list\|UserGroupsList\|reminders.list\|RemindersList" --include="*.go" .
# (no matches)

ls cmd/slackdump/internal/list/
# channels.go channels_test.go common.go doc.go mocks_test.go users.go users_test.go wizard.go
```

`slackdump list` only supports `users` and `channels`. There is no `stars`,
`usergroups`, or `reminders` subcommand anywhere in the CLI tree
(`cmd/slackdump/internal/*`).

### 2. slackdump's own Go API-client dependency implements all four

```bash
grep -n "slack" ~/.tmp/slackdump-probe/go.mod
# github.com/rusq/slack v0.9.6-0.20260212185757-ac5df963acf3
```

`rusq/slack` is a fork of `slack-go/slack` that slackdump itself imports for
every live Slack Web API call it does make (auth, channel listing, message
history). Its source tree includes:

```bash
cd ~/.tmp/rusq-slack-probe
ls *.go | grep -i "star\|usergroup\|remind\|conversation"
# reminders.go reminders_test.go stars.go stars_test.go
# usergroups.go usergroups_test.go conversation.go conversation_test.go
# websocket_stars.go admin_conversations*.go

grep -n "^func (api \*Client)" stars.go usergroups.go reminders.go | grep -i "list\|get"
# stars.go:    ListStars, ListStarsContext, GetStarred, GetStarredContext, ListAllStars, ListAllStarsContext, ListStarsPaginated
# usergroups.go: GetUserGroups, GetUserGroupsContext, GetUserGroupMembers, GetUserGroupMembersContext
# reminders.go: ListReminders, ListRemindersContext
```

`conversation.go` carries the read-state fields directly on the response
struct:

```bash
grep -n "LastRead\|UnreadCount" conversation.go
# conversation.go:18:  LastRead           string `json:"last_read,omitempty"`
# conversation.go:20:  UnreadCount        int    `json:"unread_count,omitempty"`
# conversation.go:21:  UnreadCountDisplay int    `json:"unread_count_display,omitempty"`
```

`GetConversationInfo(ctx, input)` returns a `*Channel` populated with these
fields — the exact data the manifest's `dm_read_states` schema wants
(`last_read`, `unread_count`, `unread_count_display`).

### 3. The auth mechanism these calls use is the same xoxc + `d` cookie pair the connector already captures

```bash
grep -n "func NewValueAuth\|Cookie{" ~/.tmp/slackdump-probe/auth/value.go ~/.tmp/slackdump-probe/auth/token.go
# auth/value.go:39:func NewValueAuth(token string, cookie string) (ValueAuth, error)
# auth/token.go:44:  req.Header.Add("Cookie", "d="+dCookie)
```

```bash
sed -n '370,412p' ~/.tmp/rusq-slack-probe/misc.go
```
Shows `postForm` (`application/x-www-form-urlencoded`, `token` as a form
field — used by `reminders.list`/`usergroups.list`/`stars.list`) and
`getResource` (`Authorization: Bearer <token>` header — used by
`conversations.info`). Both ride the client's cookie jar, which
`NewValueAuth` seeds with `Cookie: d=<cookie>`.

This is precisely `SLACK_TOKEN` (an `xoxc-...` value) +
`SLACK_COOKIE` (the `d` cookie value), which the connector's manifest
(`packages/polyfill-connectors/manifests/slack.json` → `setup.credential_capture.fields`)
already captures and which `static-secret-injection.ts` already injects as
env vars into the connector process. No new credential field, scope, or
auth flow is required.

### 4. All four methods are documented, live, and not deprecated

Checked each method's Slack API reference page (`docs.slack.dev/reference/methods/<method>`)
for its rate-limit tier and any deprecation notice:

| Method | Tier | Deprecated? |
|---|---|---|
| `stars.list` | Tier 3 (50+ req/min) | No — usage note says the *UI* (Starred items) was superseded by "Later", but the method is not flagged deprecated. |
| `usergroups.list` | Tier 2 (20+ req/min) | No |
| `reminders.list` | Tier 2 (20+ req/min) | No |
| `conversations.info` | Tier 3 (50+ req/min) | No |

Rate-limit tier table: <https://docs.slack.dev/apis/web-api/rate-limits/>
Per-method Facts boxes: <https://docs.slack.dev/reference/methods/stars.list>,
<https://docs.slack.dev/reference/methods/usergroups.list>,
<https://docs.slack.dev/reference/methods/reminders.list>,
<https://docs.slack.dev/reference/methods/conversations.info>

The 2025-05 rate-limit tightening (`docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/`)
affects `conversations.history`/`conversations.replies` specifically (moved
to Tier 1 for non-Marketplace commercial apps) and does not name these four
methods.

## Decision

All four streams are source-exposed and reachable with the existing
credential. None warrant a permanent `deferred`/`unsupported`/`unavailable`
manifest claim. Promoted to implementation — see `../design.md`.
