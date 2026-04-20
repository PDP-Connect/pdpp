# Slack connector

Wraps [slackdump](https://github.com/rusq/slackdump) to pull a workspace's full history into PDPP. Slackdump maintains its own SQLite archive at `~/.pdpp/slackdump/<workspace>/archive/slackdump.sqlite`; the connector reads that archive and emits RECORDs.

## How "pull only what's missing" works

Every connector run goes through slackdump's **resume** path as long as an archive exists on disk — whether or not PDPP's own state has been committed. Resume reads the archive's `SESSION` / `V_UNFINISHED_CHANNELS` tables and picks up each channel where the last session stopped:

- A completed session's channels are skipped entirely
- A partially-fetched channel gets its remaining messages / threads / files pulled
- New channels added since last run are discovered and dumped
- Messages newer than the `-lookback` window (default 7 days) in already-dumped channels are delta-fetched

**You never re-pull fully-completed channels.** A second run of a finished workspace takes minutes, not hours.

## Retry budget and the "exit 6" class of failure

Slack's API occasionally returns `500 Internal Server Error` on `conversations.history` and `conversations.replies`, especially for bot-heavy channels with thousands of threads. Default slackdump retry budgets (3 per tier_3/tier_4 request) exhaust quickly on those channels — one unlucky channel can abort the entire run with exit code 6 while other channels are still pending.

The connector ships `config/slackdump-api-config.toml` with `tier_3.retries` and `tier_4.retries` bumped from 3 to 20, aligning them with `tier_2`'s rate-limit retry budget. This was tuned live 2026-04-20 after `eng_github` (2,645 threads, heavy GitHub-webhook bot traffic) aborted a 5-hour dump.

If a channel still fails after this, resume will pick it up on the next run with fresh retries — no data from other channels is lost.

## Escape hatch: `PDPP_SLACK_SKIP_SLACKDUMP=1`

Set this env var to skip the slackdump refresh step and ingest whatever's already on disk. Useful when you need to get a partial archive into PDPP without waiting for another full resume cycle, or when the Slack API is having a bad day.

```bash
PDPP_SLACK_SKIP_SLACKDUMP=1 node bin/orchestrate.js run slack
```

## Operational state on disk

```
~/.pdpp/slackdump/<workspace>/archive/
├── slackdump.sqlite      # the archive (574k message rows = 186k unique messages across sessions)
└── __uploads/            # downloaded file attachments
```

The SQLite schema has useful introspection views:
- `V_UNFINISHED_CHANNELS` — channels with threads referenced but not fetched
- `V_LATEST_MESSAGE` — the newest message per channel
- `V_CHANNEL_THREAD_COUNT` — thread density per channel

Query them directly to answer "what's missing?" without running slackdump.

## Why we dedupe `MESSAGE` rows by `MAX(CHUNK_ID)`

Slackdump writes the same logical message to multiple chunks within a single dump session — once during channel enumeration, again during thread expansion, possibly again during file cataloging, again on every subsequent session that touches the channel. A 574k-row `MESSAGE` table typically contains only 186k distinct `(CHANNEL_ID, TS)` tuples. Each row has a progressively richer `DATA` blob, so picking the `MAX(CHUNK_ID)` per tuple gets the most complete version of each message.

## Streams emitted

`workspace`, `channels`, `channel_memberships`, `users`, `messages`, `message_attachments`, `reactions`, `files`, `canvases`, `dm_read_states`.

Declared but not realizable from a slackdump archive (see comments in `index.js`):
- `stars` — slackdump defines CHUNK type 8 STARRED_ITEMS but archive mode doesn't populate it
- `user_groups` — requires `usergroups.list`, not called in archive mode
- `reminders` — requires `reminders.list`, not called in archive mode

## Auth

Requires `SLACK_TOKEN`, `SLACK_COOKIE`, `SLACK_WORKSPACE` in env. Bootstrap these via `bin/bootstrap-slack-session.js` (Playwright-driven login).
