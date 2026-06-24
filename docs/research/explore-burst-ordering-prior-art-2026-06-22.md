# Explore burst ordering — prior art (2026-06-22)

Question: in a reverse-chron, day-bucketed feed that groups consecutive same-stream records into "bursts", how should the BURSTS be ordered within a day? Triggered by Tim observing a non-monotonic across-burst order live: Codex/messages (23m) → Codex/function_calls (19m) → Claude Code/messages (31m).

## Verdict: the observed 23→19→31 IS a bug, not a vetted ideal.

Consensus across Stream, Gmail (regular inbox), GitHub, Android/Material, Slack: a burst inherits the timestamp of its **NEWEST member**; bursts sort **newest-first** by that within the day; items inside a burst stay newest-first. Ordering bursts by first-seen/arrival (what we currently do) or by oldest member is the documented anti-pattern.

## Findings

1. **Stream (getstream.io) Activity Feeds** — cleanest documented rule: aggregated groups sorted by the group's `updated_at` DESC ("most recently active group first"); a new activity bumps the group's `updated_at` and bubbles it to top. Non-time order requires explicit `ranking`/`score_strategy` opt-in. https://getstream.io/activity-feeds/docs/javascript/aggregation/ , https://getstream.io/blog/aggregated-feeds-demystified/

2. **Gmail** — regular Inbox sorts conversations by the LAST message's date (= newest member). Priority Inbox historically used the FIRST message's date (oldest member) and users flagged it confusing ("replies hidden pages away"). Within-thread = oldest-first, but threads rank by newest message (deliberate split-axis). https://support.google.com/mail/thread/4048418

3. **GitHub Feed (Feb 2025)** — REVERTED algorithmic/out-of-sequence ordering back to strict chronological after user revolt: "the out-of-sequence ordering of activity can make it difficult to be effective… now we're sorting all activity chronologically. The newest activity appears first." Bundles ("pushed N commits") sit at their event time. Direct evidence non-monotonic across-group order is an anti-pattern they removed. https://github.blog/changelog/2025-02-14-reverting-feed-activity-sorting-back-to-chronological-ordering/

4. **Android / Material notifications** — newest-first within a group is default; `setSortKey()` overrides draw the "everything is jumbled up / a message drops down a few minutes later" complaint. https://developer.android.com/develop/ui/views/notifications/group

5. **Slack** — consecutive-message grouping never reorders the timeline; the block stays anchored at its real channel-sequence position. Grouping is presentation-only over monotonic sequence. https://engineeringenablement.substack.com/p/slack-system-design-what-actually

6. **Datadog Log Patterns** — the legitimate counter-example: clusters sorted by VOLUME desc, not time, because the job is "find the noisiest pattern" — but the non-time axis is explicit and labeled. (Only acceptable when the organizing axis is the visible, intended one.) https://docs.datadoghq.com/logs/explorer/analytics/patterns/

7. **Anti-pattern + usability** — Strava/Instagram chronological→algorithmic both drew backlash and re-added chronological. Lesson: establish legible stable ordering; don't let grouping silently break time order. https://www.aubergine.co/insights/a-guide-to-designing-chronological-activity-feeds

## Recommendation (to implement, gated)

Give every burst `latestAt = max(member semanticTime/displayAt)`. Within a day bucket, sort bursts by `latestAt DESC`; keep members newest-first inside each burst. INVARIANT: scanning top-to-bottom, every timestamp (across burst headers AND within bursts) only goes backward in time. For the worked example: B (19m) → A (23m) → C (31m).

DO NOT order bursts by oldest/first member (the Gmail-Priority-Inbox mistake). DO NOT keep first-seen/arrival order (current behavior — the GitHub-class bug). Also decide: should bursts interleave with SINGLES by time too? Currently canvas renders all bursts then all singles — same class of problem; the fix should order the day's RENDER UNITS (bursts + singles) together by their newest timestamp, not bursts-then-singles.

## Current code (the bug site)
- `apps/console/src/app/dashboard/explore/explore-feed-grouping.ts` splitDayBursts: `bursts` built from `[...burstMap.entries()]` = Map insertion (first-seen) order, no time sort.
- `apps/console/src/app/dashboard/explore/explore-canvas.tsx` FeedDays (~1517/1531): renders `g.bursts.map(...)` THEN `g.singles.map(...)` — bursts-before-singles regardless of time.
