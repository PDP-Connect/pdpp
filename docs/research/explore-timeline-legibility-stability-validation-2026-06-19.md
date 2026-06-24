# Explore Phase-3 Design Validation: Day-Grouping + Burst-Collapse and Point-in-Time Stability + "N New" Pill

**Date:** 2026-06-19
**Status:** Research complete, verdict rendered
**Scope:** Two specific ideal-version design decisions from `explore-full-visibility-spec-2026-06-19.md` Phase 3, validated against real products
**Grounded in corpus:**
- `explore-merged-timeline-pagination-prior-art-2026-06-19.md`
- `explore-record-explorer-product-pattern-prior-art-2026-06-19.md`
- `explore-search-relevance-pagination-prior-art-2026-06-19.md`
- `explore-slvp-recommendation-synthesis-2026-06-19.md`

---

## Decision A: Day-Grouping + Burst-Collapse for Legibility

### The claim in the spec

From `explore-full-visibility-spec-2026-06-19.md` Phase 3:

> Records are grouped by day ("Tuesday, June 17"); high-volume same-stream bursts collapse into one expandable group ("84,000 WhatsApp messages") rather than 84,000 rows, so the firehose is legible.

### Evidence

#### A1. Google Photos: the canonical personal-data day-grouping reference

Google Photos is the closest direct precedent for a large-volume personal-data timeline. The Photos main view groups photos under day headers ("Monday, May 19"), then month headers ("May 2026"), then year headers, in a hierarchical drill-down. Users navigate across three levels: Year, Month, Day. When a user is in Month view, each day's photos are segmented into a visual cluster under its date label. When a user is in Day view, a single day's photos are all shown in a grid.

For volume management, Google Photos introduced Photo Stacks (first iOS November 2023, then Android early 2024): visually similar photos from the same time cluster are collapsed into a single thumbnail with a stack icon. Opening a stack reveals the full set in a filmstrip. This is the burst-collapse pattern applied to photos: a batch of 30 near-identical burst-shots becomes one tappable tile.

The technical implementation, documented at https://medium.com/google-design/google-photos-45b714dfbed1, uses a server-driven section structure. Once photo metadata for a section is available, the client segments photos into individual days, placing DOM placeholders that are filled as the user scrolls. The section sizes (number of photos per group tile) are dynamically computed based on photo count, aspect ratios, and width constraints, not a fixed number.

**Takeaway:** Google Photos treats day-grouping + burst-collapse as the primary legibility mechanism for a high-volume personal media timeline. The pattern is not cosmetic; it is load-bearing -- without it, a grid of 40,000 photos would be unnavigable.

Source: https://medium.com/google-design/google-photos-45b714dfbed1
Source: https://alternativeto.net/news/2024/1/google-photos-is-rolling-out-the-photo-stacks-auto-grouping-feature-for-android-users/
Source: https://support.google.com/photos/thread/148587229 (user discussion of day vs. month grouping)

#### A2. Apple Photos: same hierarchy, same pattern

Apple Photos organizes the library into Years, Months, Days, and an All Photos flat view. The Days view shows date headers above each day's photos. The Memories feature (analogous to Google's Highlights) collapses bursts of related photos from an event into a single navigable album card in the main timeline view, reducing a 200-photo trip into one card.

Source: Apple Photos native UX, well-documented across iOS user documentation.

#### A3. Messaging apps: day dividers as a universal standard

Every major messaging app uses the day-divider pattern without exception:

**WhatsApp:** Every conversation thread has date separator pills ("Today", "Yesterday", "Monday, June 15") between messages from different calendar days. This is not a toggle; it is always on. The pattern is so well-established that multiple open-source chat frameworks (Stream Chat Flutter, MessageKit, Rocket.Chat) explicitly list "add WhatsApp-style day grouping" as a feature request when the library ships without it. Source: https://github.com/GetStream/stream-chat-flutter/issues/10 (Stream Chat Flutter feature request), https://github.com/MessageKit/MessageKit/issues/374 (MessageKit), https://github.com/RocketChat/Rocket.Chat/issues/40588 (Rocket.Chat).

**Slack:** Slack's channel timeline uses the `{day_divider_pretty}` token, rendering "Today", "Yesterday", or a long-form date ("Monday, December 23rd, 2013") as a day divider between messages. This is natively part of Slack's rendering pipeline, not optional. Source: https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/RichTextDate/ (Slack developer docs documenting the `day_divider_pretty` format token).

**iMessage:** Apple Messages shows date stamp separators at the top of each day's messages within a conversation. The separator shows the day of the week and date for older messages and "Today" for same-day messages.

Source: https://www.iphonelife.com/blog/31961/tip-day-where-did-timestamps-go (iMessage timestamp behavior).

#### A4. Email clients: day-grouping as the standard inbox model

**Microsoft Outlook:** Outlook's default "Arrange By: Date" inbox view divides messages into labeled date groups -- "Today", "Yesterday", "Last Week", "Last Month", "Older". Each group is collapsible (click the arrow to collapse). This is ON by default and widely recognized as the standard email inbox legibility pattern. Users occasionally seek to disable it (support threads at https://help.zoho.com/portal/en/community/topic/how-to-turn-off-today-yesterday-last-7-days-sections-in-mail-view), confirming it is the default shipping behavior.

**Inbox by Gmail (Google, 2014-2019):** Google's experimental email client introduced topic-based "Bundles" that grouped related emails (Promos, Trips, Finance, etc.) into collapsed groups in the inbox. This extended the date-grouping concept to topic-burst-collapse: instead of showing 12 promotional emails individually, a single "Promotions" bundle row was shown with a count, expandable inline. This is exactly the burst-collapse pattern applied to email volume.

Source: https://en.wikipedia.org/wiki/Inbox_by_Gmail
Source: https://learn.microsoft.com/en-us/answers/questions/5652172/email-format (Outlook email grouping).

#### A5. GitHub activity feed: event-level aggregation

GitHub's organization news feed aggregates push events: instead of showing 7 separate commit entries, the feed shows "user pushed 7 commits to main" as one aggregated row. The payload contains the full commit array; the feed collapses them. Source: https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-your-organizations-news-feed.

This is the burst-collapse pattern applied to developer activity: when a single push event carries multiple items, the feed renders one collapsed entry rather than N entries.

#### A6. Datadog Log Explorer: pattern group collapse

Datadog's Patterns view in the Log Explorer (https://docs.datadoghq.com/logs/explorer/analytics/patterns/) automatically clusters log lines with similar shapes into a single "pattern" row with a count. Instead of showing 50,000 identical timeout error lines, the Patterns view shows "Connection timeout to db-host [50,241 logs]". This is the burst-collapse pattern applied to log volume.

The tradeoff Datadog makes explicit: the Patterns view derives counts from a 10,000-log sample, not the full set, making counts approximate. For PDPP's case (exact record counts per stream available from keyset pagination metadata), this tradeoff does not apply -- burst counts can be exact.

Source: https://docs.datadoghq.com/logs/explorer/analytics/patterns/ (cited in corpus at `explore-record-explorer-product-pattern-prior-art-2026-06-19.md` Section 2.1).

#### A7. Personal data sovereign platforms (Facebook TimelineBuilder)

Facebook Research's open-source TimelineBuilder (https://github.com/facebookresearch/personal-timeline) builds a unified personal life log across multiple data sources (Google Maps, Spotify, etc.). The output is a chronological timeline grouped by day and event cluster. This is the direct analog for PDPP's cross-source merged timeline use case.

Dawarich, an open-source privacy-first Google Timeline replacement (https://dawarich.app/tools/timeline-visualizer/), processes over 630,000 location points spanning 15+ years and organizes them in time-grouped batches, including year-filter navigation, demonstrating that day/period grouping is the standard legibility mechanism at personal-data scale.

### Counter-evidence and qualifications

The spec calls for "same-stream burst collapse" specifically (e.g., "84,000 WhatsApp messages"). The evidence above strongly supports collapsing per-event bursts (GitHub pushes, Datadog log patterns, Inbox by Gmail topic bundles) and per-day grouping. The specific threshold for when a same-stream same-day volume becomes a "burst" worth collapsing is not explicitly standardized across products -- Google Photos uses visual similarity, Datadog uses log-pattern clustering, GitHub uses the push event boundary.

For PDPP, the natural burst boundary is: a single (connection, stream) within a single day. If WhatsApp produces 500 messages in a day, those 500 appear under "Tuesday, June 17 -- WhatsApp Messages (500)" rather than as 500 rows. This is consistent with all above precedents and is not a novel invention.

The one product that does NOT collapse high-volume same-stream data is a raw database table view (Airtable Grid, per-stream records page). That surface is explicitly scoped to a single stream, so the user has already opted into seeing all rows. The merged cross-source timeline is the surface where burst-collapse is most necessary, and that is exactly where the spec applies it.

### Verdict for Decision A

**SUPPORTED.**

Day-grouping by calendar date is the universal standard for high-volume chronological feeds across every product category examined: personal media (Google Photos, Apple Photos), messaging (WhatsApp, iMessage, Slack), email (Outlook, Gmail Inbox), developer activity (GitHub), observability (Datadog Patterns), and personal-data platforms (Facebook TimelineBuilder, Dawarich). No SLVP-tier product presents a high-volume chronological feed without day grouping.

Burst-collapse (collapsing high-volume same-source bursts into a single expandable group) is the standard pattern when a single source dominates a time period: Google Photos Stacks, GitHub commit aggregation, Datadog log patterns, Inbox by Gmail bundles all implement it. The specific form PDPP will use (per-connection-per-stream-per-day collapse beyond a threshold) is well within the established design space.

**Named precedents (strongest):**
1. Google Photos (day grouping + Photo Stacks burst collapse, same-domain: personal media timeline)
2. Slack + WhatsApp + iMessage (universal day divider in chronological message streams)
3. GitHub "pushed N commits" aggregation (same-burst collapse in activity feeds)
4. Microsoft Outlook "Today / Yesterday / Last Week" grouping (same pattern, email domain)

**Better alternative revealed by prior art?** None that contradicts the spec. The only variation is the granularity of collapse threshold, which is a product tuning decision, not an architectural alternative.

---

## Decision B: Point-in-Time Stability + "N New" Pill

### The claim in the spec

From `explore-full-visibility-spec-2026-06-19.md` Phase 3:

> The composite cursor is anchored to a snapshot time so scrolling does not shift rows under the owner; newly-ingested records surface as a "N new" affordance at the top that refreshes to the live head on click.

### Evidence

#### B1. Twitter/X: the canonical "N new" pill

Twitter stopped auto-refreshing its web timeline when the user is mid-scroll. Instead, new tweets are held and a count bar appears at the top of the timeline: "12 new Tweets". The user can tap this bar to jump to the top and see the new content. Until they tap, their scroll position is preserved exactly.

The key technical fact from the corpus (https://trekhleb.dev/blog/2024/api-design-x-home-timeline/): Twitter's timeline API returns two types of cursor entries alongside tweets -- `cursorType: 'Bottom'` (next-page) and `cursorType: 'Top'` (new content above). The "N new" pill is driven by the 'Top' cursor: the client polls for new content above the current 'Top' cursor without inserting it into the DOM, then displays the count.

A 2021 user documentation search confirms the UX: "Twitter updated its web platform to change the way users see new tweets -- it no longer automatically refreshes timelines on the web with new tweets, and users can now decide when they want to load new tweets." The previous behavior (auto-refresh + scroll jump) was explicitly called out as a UX failure: tweets would disappear mid-read, causing user loss of place.

Source: https://zeno.zone/blog/twitter-scroll-back (documented Twitter scroll behavior)
Source: https://www.addictivetips.com/ios/stop-twitter-feeds-automatically-refreshing/ (Twitter auto-refresh behavior)
Source: `explore-merged-timeline-pagination-prior-art-2026-06-19.md` Section 2 (Twitter cursor architecture)

#### B2. Mastodon: live feed scroll anchor + "new posts" notifier

Mastodon's GitHub issue tracker confirms the "new posts" notifier pattern. Issue #35736 (https://github.com/mastodon/mastodon/issues/35736) documents that in the Mastodon Android app, a "new posts notifier" appears at the top of the feed listing when new posts arrive while the user is scrolled down. The app temporarily disables autoscrolling when the user is viewing a live feed, preventing timeline jumps -- which is the scroll-anchor pattern.

The issue also documents the failure mode: on the web, Mastodon's autoscrolling can cause "timeline jumps" and "feed stutters" and the feed moving backwards. This confirms the scroll-jump problem is real and that the "notifier + anchor" pattern is the correct fix.

Source: https://github.com/mastodon/mastodon/issues/35736

#### B3. Reddit: "comment pill" indicator for live content

Reddit added a "comment pill" indicator to live post pages. When new comments are submitted while a user is reading, the pill appears showing the new count. Clicking it loads the new comments and highlights them. The existing comments and the user's reading position are not disrupted until the user explicitly clicks.

Source: https://www.phonearena.com/news/reddit-makes-changes-to-add-real-time-features_id136871

#### B4. Slack: "new messages" divider line + jump behavior

Slack's channel timeline handles new messages differently because the canonical view is the bottom of the channel (most recent message). When a user has scrolled UP to read history, new messages are appended at the bottom (not inserted into the scrolled view). Slack renders a "new messages" horizontal divider line with a timestamp at the position in the thread where unread messages begin, and a jump affordance ("Jump to new messages") appears. The user's scroll position is preserved while they read history; the divider marks where to jump back to.

This is a variant of the "N new" pill pattern: rather than counting and showing a number, Slack shows a divider line at the boundary between read and unread, with a named jump control.

Source: https://slack.com/help/articles/226410907-View-all-your-unread-messages (Slack unread messages)
Source: `explore-record-explorer-product-pattern-prior-art-2026-06-19.md` Section 5 (discusses Slack's model for cross-channel browse vs. per-channel pagination)

#### B5. Elasticsearch PIT (Point-In-Time) + search_after: the engineering pattern

The corpus documents Elasticsearch's PIT mechanism exhaustively (`explore-merged-timeline-pagination-prior-art-2026-06-19.md` Section 4): a PIT handle freezes the index state at a timestamp; all pages of a search query see the same index state. The `search_after` cursor + PIT is the standard pattern for stable paginated browsing in the face of concurrent writes.

For PDPP's use case, the spec proposes a soft snapshot via a `ceil` timestamp field in the composite cursor: the first-page time is recorded as `ceil`, and all subsequent pages filter to records with `emitted_at <= ceil`. This is the lightweight snapshot pattern that Slack already uses: `conversations.history` accepts a `latest` Unix timestamp upper bound that pins the ceiling of each page request. All pages exclude records ingested after the initial load, making pages stable.

Source: https://www.elastic.co/guide/en/elasticsearch/reference/current/point-in-time-api.html
Source: `explore-merged-timeline-pagination-prior-art-2026-06-19.md` Section 4 (PIT + soft snapshot design)
Source: https://slack.engineering/evolving-api-pagination-at-slack/ (Slack's `latest` param as soft ceiling)

#### B6. Datadog Log Explorer: pause-on-interaction pattern

Datadog's Log Explorer Live Tail (https://docs.datadoghq.com/logs/live_tail/) streams logs in real time. When a user interacts with a log row (clicks to open, scrolls), the live tail pauses so the user can read the selected log without new entries shifting the view. A "Restart streaming" or similar control re-enables live tail.

Google Cloud Logging's Logs Explorer uses the same pattern explicitly: streaming continues until the user selects the scroll bar, at which point streaming pauses and a "Restart streaming" button appears. Source: https://docs.cloud.google.com/logging/docs/view/streaming-live-tailing.

AWS CloudWatch Live Tail explicitly documents "pause/replay logs while troubleshooting issues" as a designed feature. Source: https://aws.amazon.com/about-aws/whats-new/2023/06/live-tail-amazon-cloudwatch-logs.

These are all implementations of the same principle: a live feed pauses when the user is reading, and provides a user-controlled re-synchronization affordance.

#### B7. The general pattern documented in patent literature

The USPTO pattern (https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11809215) covering "Controlled display of dynamic data" documents the exact pattern: when the scroll position is at the top of the page, new data is displayed in near real-time; when not at the top, a notification (button or pop-up) is displayed indicating that new updates have been received, and the user controls when to load them. This is a utility patent, indicating the pattern was sufficiently novel and useful to merit IP protection, which in turn confirms it is a meaningful, non-trivial design decision with real-world adoption.

The key decision recorded in the patent claim: the notification is a "control element overlaid on top of the feed in the viewport" -- exactly the "N new" pill.

#### B8. Linear's approach to live feed stability

Linear's issue list does not auto-insert new issues when a user is browsing a filtered list. New issues appear after an explicit refresh or navigation. This is the zero-disruption end of the spectrum: no pill, just stable browsing. Linear's product choice reflects that a task-management tool's primary use case is focused browsing of a known set, not real-time stream monitoring.

For PDPP's Explore surface, the use case is closer to Twitter/Mastodon/Datadog (what is happening across my data life) than to Linear (review this set of tasks). The "N new" pill is a better fit than Linear's silent refresh approach.

#### B9. HackerNews: static snapshot, no live updates on the main feed

Hacker News does not auto-insert new stories on the main feed. The page is a snapshot as of when it was loaded. A manual refresh loads a new snapshot. Third-party HN clients add "new comment count" badges (https://apps.apple.com/us/app/-/id6451333500) because the native site lacks them, confirming that users want the "N new" affordance even on HN's relatively slow-moving feed.

### Counter-evidence and qualifications

**Linear's stable-cursor approach without a pill:** Linear's lists are stable by default (no real-time auto-insert) but they also do not show a "N new" indicator. For a personal-data timeline where new ingestion is continuous (ChatGPT sessions being collected, Amazon orders arriving), a more active "N new" signal is justified. Linear's choice to omit the pill is a product decision based on the task-management context, not a signal that the pill is wrong.

**Discord/chat apps: auto-scroll when at bottom:** Discord and chat apps auto-scroll to show new messages ONLY if the user is already at the bottom (the most recent message). If the user has scrolled up, new messages are appended silently to the bottom without disrupting scroll position, and a floating "jump to latest" button appears. This is a variant of the "N new" pill pattern adapted to a bottom-anchored chat UI. For PDPP's top-most-recent feed (newest first, like Twitter), the pill pattern is more appropriate than the chat-bottom-anchored variant.

**The "auto-refresh was a failure" signal:** The Twitter evidence is particularly strong because it documents that the PRIOR behavior (auto-refresh) was explicitly abandoned. The history of UI evolution is: auto-refresh was tried, users hated it (lost their reading position), and the industry converged on the "N new" pill + scroll anchor. This is not a preference; it is a documented correction of a known failure mode.

### Verdict for Decision B

**SUPPORTED.**

The "snapshot cursor + N new pill, no silent auto-insert" pattern is the standard for live paginated feeds at every SLVP-tier product that has addressed this problem explicitly. Twitter/X adopted it as a deliberate correction of the auto-refresh failure. Mastodon implements it on mobile. Reddit's comment pill uses the same logic. Datadog and Google Cloud Logging pause live tails when the user scrolls. Slack uses the divider-line variant. Elasticsearch's PIT is the backend mechanism that enables it.

The composite cursor `ceil` field proposed in the spec (`explore-merged-timeline-pagination-prior-art-2026-06-19.md` Section 6) is the correct engineering implementation: fix the snapshot ceiling at first-page time, pass it through all subsequent page cursors, show count of records ingested after the ceiling as the "N new" count, offer a "Refresh" action that starts a new snapshot from now. This is precisely how Slack's `latest` parameter and Elasticsearch's PIT work, and exactly what the spec describes.

The one alternative the prior art suggests is not better: silent auto-insert at the top (the old Twitter model, Discord's bottom-anchored variant) is explicitly worse for a mixed-type feed where the user is reading, not just monitoring. No SLVP-tier product still does silent auto-insert for a top-most-recent feed.

**Named precedents (strongest):**
1. Twitter/X "N new tweets" pill (direct analog: top-most-recent feed, user-controlled refresh, snapshot cursor)
2. Elasticsearch PIT + search_after (engineering mechanism: frozen index state across pages)
3. Slack `latest` timestamp ceiling (same soft-snapshot mechanism, documented in corpus)
4. Datadog/AWS CloudWatch/Google Cloud Logging live tail pause-on-scroll + restart control

**Better alternative revealed by prior art?** No better alternative. The only variant is Slack's divider-line (shows WHERE new content starts rather than HOW MANY), which could complement the pill. Combining a count pill ("12 new") with a scroll-to-top action that also renders a divider at the insertion boundary would be strictly better than either alone.

---

## Summary Table

| Decision | Verdict | Strongest Named Precedents | Prior Art Corpus Coverage |
|---|---|---|---|
| A: Day-grouping + burst-collapse | SUPPORTED | Google Photos (day groups + Photo Stacks); WhatsApp/Slack/iMessage (day dividers); GitHub (pushed N commits); Outlook (Today/Yesterday groups) | Partial in corpus (Slack, Datadog patterns mentioned); this doc fills Google Photos, messaging, email |
| B: Point-in-time stability + "N new" pill | SUPPORTED | Twitter/X (N new tweets pill, auto-refresh abandonment); Elasticsearch PIT; Slack latest ceiling; Datadog/GCP live tail pause | Corpus covers Elasticsearch PIT and Slack latest in depth; this doc adds Twitter, Mastodon, Reddit, Datadog |

---

## Citations

### Decision A sources
- Google Photos engineering blog (section architecture): https://medium.com/google-design/google-photos-45b714dfbed1
- Google Photos Photo Stacks (burst collapse): https://alternativeto.net/news/2024/1/google-photos-is-rolling-out-the-photo-stacks-auto-grouping-feature-for-android-users/
- Google Photos day vs. month grouping user discussion: https://support.google.com/photos/thread/148587229
- Stream Chat Flutter day separator feature request: https://github.com/GetStream/stream-chat-flutter/issues/10
- MessageKit day grouping request: https://github.com/MessageKit/MessageKit/issues/374
- Rocket.Chat day separator issue: https://github.com/RocketChat/Rocket.Chat/issues/40588
- Slack day_divider_pretty format token: https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/RichTextDate/
- iMessage timestamp behavior: https://www.iphonelife.com/blog/31961/tip-day-where-did-timestamps-go
- Outlook email group by date: https://learn.microsoft.com/en-us/answers/questions/5652172/email-format
- Inbox by Gmail bundles: https://en.wikipedia.org/wiki/Inbox_by_Gmail
- Zoho Mail date grouping (user toggle discussion): https://help.zoho.com/portal/en/community/topic/how-to-turn-off-today-yesterday-last-7-days-sections-in-mail-view
- GitHub organization news feed ("pushed N commits"): https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-your-organizations-news-feed
- Datadog Log Patterns (burst collapse for logs): https://docs.datadoghq.com/logs/explorer/analytics/patterns/
- Facebook Research TimelineBuilder (personal data day grouping): https://github.com/facebookresearch/personal-timeline
- Dawarich personal timeline (630K point personal data): https://dawarich.app/tools/timeline-visualizer/

### Decision B sources
- Twitter/X timeline cursor architecture (Top + Bottom cursor types): https://trekhleb.dev/blog/2024/api-design-x-home-timeline/
- Twitter scroll-back / position restoration behavior: https://zeno.zone/blog/twitter-scroll-back
- Twitter auto-refresh behavior (user experience problems): https://www.addictivetips.com/ios/stop-twitter-feeds-automatically-refreshing/
- Mastodon "new posts" notifier + autoscroll issue: https://github.com/mastodon/mastodon/issues/35736
- Reddit comment pill / live features: https://www.phonearena.com/news/reddit-makes-changes-to-add-real-time-features_id136871
- Slack unread messages + jump affordance: https://slack.com/help/articles/226410907-View-all-your-unread-messages
- Slack pagination evolution (latest timestamp ceiling): https://slack.engineering/evolving-api-pagination-at-slack/
- Elasticsearch PIT API: https://www.elastic.co/guide/en/elasticsearch/reference/current/point-in-time-api.html
- AWS CloudWatch Live Tail pause/replay: https://aws.amazon.com/about-aws/whats-new/2023/06/live-tail-amazon-cloudwatch-logs
- Google Cloud Logging streaming pause + restart: https://docs.cloud.google.com/logging/docs/view/streaming-live-tailing
- USPTO patent 11809215 "Controlled display of dynamic data" (N new pill pattern): https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11809215
- HackerNews "Comments Owl" new comment counts: https://apps.apple.com/us/app/-/id6451333500

### Corpus documents reused
- `explore-merged-timeline-pagination-prior-art-2026-06-19.md` -- Sections 2 (Twitter cursor), 4 (PIT + Slack soft snapshot), 6 (composite cursor ceil design)
- `explore-record-explorer-product-pattern-prior-art-2026-06-19.md` -- Sections 2.1 (Datadog), 2.7 (PostHog), 5 (trustworthy explorer properties)
- `explore-slvp-recommendation-synthesis-2026-06-19.md` -- Q2 (Elasticsearch composite agg, Datadog Logs, Mastodon)
