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

## Disk and run-time

The persistent archive has two independently-growing parts with different cost
profiles — do not conflate them:

- **`slackdump.sqlite`** is the connector's source of truth *and* slackdump's
  resume state. Never delete it: doing so forces a full multi-hour re-dump and
  can create resume gaps. This is not redundant with PDPP — PDPP stores the
  emitted RECORDs, not slackdump's chunk/session structure.
- **`__uploads/`** holds downloaded file-attachment bytes. **The connector
  never reads these bytes** — file/attachment streams emit metadata only, and
  PDPP has no blob copy of them. With `SLACK_SKIP_FILES=true` (the default),
  slackdump runs `-files=false` and `__uploads/` never grows.

**Run time scales with new data, not archive size.** The message read pushes
the committed per-channel/legacy cursor into the dedup CTE, so the
`MAX(CHUNK_ID) GROUP BY (CHANNEL_ID, TS)` aggregation only touches rows newer
than the cursor instead of the whole (unbounded, un-indexed) `MESSAGE` table on
every run. Every run reports per-phase timing and an archive size snapshot via
`PROGRESS` (`slackdump-subprocess`, `archive-open`, `read-and-emit`, and
`sqlite=…B uploads=…B`) so this bound is measurable and regressions are visible.

**Scoped-archive reconciliation (channel healing) is finite by construction,
not by a wall-clock cap.** If an unscoped run finds a previously-observed
channel missing from the main archive, it heals the gap by refreshing/repairing
isolated `archive-scoped/<digest>/` archives — at most one refresh per existing
scoped archive already covering a missing channel, plus at most one additional
repair attempt for whatever remains uncovered. That repair-unit count is known
before any subprocess runs (a plain array-difference over this run's own state,
not a query that can grow mid-run), and each unit's own Slack-API-side scope is
separately bounded by `SLACK_LOOKBACK_DAYS` (`-lookback p<N>d`, default `p7d`).
The `scoped-archive-reconcile` phase reports the selected unit count and
lookback window before starting, a completed/remaining cursor per unit, and an
explicit `0 remaining` at the end — so a single run can neither rediscover nor
reprocess an unbounded set. The *wall-clock duration* of an individual unit is
NOT bounded by this — it is genuine Slack-API backlog catch-up within the fixed
lookback window, subject to Slack's own rate limits.

**A retained scoped archive's `resume` is throttled to at most once per
lookback window, not invoked every run — and only a genuinely completed
resume counts.** `slackdump resume <path>` always re-syncs every channel
already recorded in that archive's own DB (its scope comes from the
archive's own history, not from the connector's target channel list — this
is different from `archive`, which does respect the requested channel IDs).
A channel that is permanently missing from the main archive (e.g. no longer
a member, with `SLACK_MEMBER_ONLY=true`) keeps its covering scoped archive
selected on every run forever; without a throttle, that means a full
re-sync of the archive's ENTIRE accumulated content every run, regardless of
how recently it was last resumed. Since `-lookback pNd` cannot discover data
older than `now - N days` no matter how often it's invoked, a resume is only
genuinely useful once per lookback window — the connector tracks
`scoped_archive_resumed_at` per archive path in STATE and skips the
subprocess entirely (never even calling `ensureArchiveOnDisk`) when the
archive was already resumed within the window, resuming again exactly once
the window elapses. No coverage is lost, only deferred to at most
`SLACK_LOOKBACK_DAYS`.

Success and failure are distinct, never-conflated facts: `scoped_archive_
resumed_at` only advances when a resume actually completes without error. A
failed attempt leaves the archive owed for the very next run — it is never
recorded as if it had succeeded — and instead surfaces a durable, typed
`DETAIL_GAP` (the same recoverable-work mechanism other connectors use for
failed detail hydration), so retry pacing for the failure is owned by the
existing connector-runtime recovery governor, not a bespoke connector-local
suppression. A later successful resume of that archive closes out the gap
with a matching `DETAIL_GAP_RECOVERED`.

### Reclaiming `__uploads/` (`SLACK_RECLAIM_UPLOADS=1`) — opt-in, one-way

If a past run downloaded files (`SLACK_SKIP_FILES=false`), `__uploads/` can hold
tens of GB of bytes the connector does not ingest. Set `SLACK_RECLAIM_UPLOADS=1`
to remove `__uploads/` **after** the run's records are durably accepted (the
reclaim runs on the runtime's durable-commit ack, never before, and never on a
failed run). It reclaims **every archive this run actually created or read** —
the base archive, any scoped archive folded into this run's message pass, and
any repair attempt that successfully created/read an archive even when it
recovered no matching channel — not only the base archive and not only archives
that turned out useful. It removes only each archive's `__uploads/` — never
`slackdump.sqlite` or its `-wal`/`-shm` sidecars — and reports the reclaimed
byte count as **stderr** evidence (`[onDurableCommit] ...`), not a `PROGRESS`
line: by the time this hook runs, the runtime has already consumed the run's
`DONE` and would reject any further stdout JSONL as a protocol violation.

This is **one-way and unrecoverable**:

- PDPP holds no copy of these bytes.
- slackdump will **not** re-download them — its resume file-dedup is DB-only
  (keyed on the still-present `FILE` row), so a reclaimed file is treated as
  "already have it" forever. To force a re-fetch you must re-run `archive` (not
  `resume`) with `SLACK_SKIP_FILES=false`.
- The stored `url_private` URLs require live Slack auth and are short-lived.

It is off by default and never automatic — an operator may have intentionally
set `SLACK_SKIP_FILES=false` to retain bytes locally.

## Why we dedupe `MESSAGE` rows by `MAX(CHUNK_ID)`

Slackdump writes the same logical message to multiple chunks within a single dump session — once during channel enumeration, again during thread expansion, possibly again during file cataloging, again on every subsequent session that touches the channel. A 574k-row `MESSAGE` table typically contains only 186k distinct `(CHANNEL_ID, TS)` tuples. Each row has a progressively richer `DATA` blob, so picking the `MAX(CHUNK_ID)` per tuple gets the most complete version of each message.

## Streams emitted

Read from the slackdump SQLite archive: `workspace`, `channels`, `channel_stats`, `channel_memberships`, `users`, `messages`, `message_attachments`, `reactions`, `files`, `canvases`.

Read via direct Slack Web API calls (see `slack-api.ts`) using the same session credential slackdump uses — slackdump's own CLI doesn't call these methods, but the `xoxc` token + `d` cookie it's given can call them directly:
- `stars` — `stars.list`
- `user_groups` — `usergroups.list`
- `reminders` — `reminders.list`
- `dm_read_states` — `conversations.info`, scoped to `is_im`/`is_mpim` channels (per-channel call, not swept across the full channel inventory)

See `openspec/changes/complete-slack-bundled-connector-coverage` for the evidence that these four methods are reachable with the connector's existing credential.

## Auth

Requires `SLACK_TOKEN`, `SLACK_COOKIE`, `SLACK_WORKSPACE` in env. Capture `SLACK_TOKEN` (an `xoxc-` token) and `SLACK_COOKIE` (the `d=...` cookie value) from a logged-in browser session against your workspace.

Slackdump resolution:

- Host runs: put `slackdump` on `PATH` or set `SLACKDUMP_BIN` to the binary path.
- Docker runs: the stock PDPP reference image does not bundle AGPL-3.0 `slackdump`. Build a derived image that installs it, or mount the binary into the container and set `SLACKDUMP_BIN` to that in-container path.
- Missing binary failures are reported before credentials are printed; do not paste Slack tokens into logs.
