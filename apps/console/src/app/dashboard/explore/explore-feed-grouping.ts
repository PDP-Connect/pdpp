/**
 * Pure feed-grouping logic for the Explore canvas.
 *
 * Extracted into a standalone module (no React, no "use client") so that
 * node:test suites can import and exercise it directly without pulling in
 * the full client component tree.
 *
 * Consumers: explore-canvas.tsx (rendering) + explore-feed-grouping.test.ts
 */

import type { ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";

// ─── Day label ───────────────────────────────────────────────────────────────

const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export const MS_PER_DAY = 86_400_000;

/**
 * Human-readable day label with relative names for recent days.
 *
 * - "Today"     — if `day` matches today's UTC date
 * - "Yesterday" — if `day` matches yesterday's UTC date
 * - "Tomorrow"  — if `day` matches tomorrow's UTC date (future groups)
 * - "Thursday, June 19, 2026" (full weekday+year+month+date) — any other day. The
 *   YEAR is included: this is a multi-year personal corpus, so an unqualified
 *   "Monday, April 20" is ambiguous across years.
 * - "Undated"   — for empty or unparseable day strings
 *
 * The `nowMs` parameter (default `Date.now()`) lets tests pin the clock.
 */
export function dayLabel(day: string, nowMs: number = Date.now()): string {
  if (!day) {
    return "Undated";
  }
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    return "Undated";
  }
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  const yesterdayKey = new Date(nowMs - MS_PER_DAY).toISOString().slice(0, 10);
  const tomorrowKey = new Date(nowMs + MS_PER_DAY).toISOString().slice(0, 10);
  if (day === todayKey) {
    return "Today";
  }
  if (day === yesterdayKey) {
    return "Yesterday";
  }
  if (day === tomorrowKey) {
    return "Tomorrow";
  }
  return DAY_FMT.format(new Date(ms));
}

/** Today's UTC date key ("YYYY-MM-DD"). A day strictly after this is "future". */
export function todayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** True when a feed entry's day is strictly AFTER today (a scheduled/future record). */
export function isFutureDay(day: string, nowMs: number = Date.now()): boolean {
  return day !== "" && day > todayKey(nowMs);
}

// ─── Burst collapse ──────────────────────────────────────────────────────────
//
// When a single (connectionId, stream) pair contributes >= BURST_THRESHOLD
// records in a day group, collapse them into one expandable "burst" row so
// the feed stays legible ("84,000 WhatsApp messages" instead of 84,000 rows).

/** Collapse partitions with >= this many records per day into burst groups. */
export const BURST_THRESHOLD = 10;

/**
 * How many content rows a burst shows BY DEFAULT (the `preview` state).
 *
 * SLVP rule (Codex plan-check 2026-06-22, prior art Linear/Slack/Datadog): a
 * browse feed must never render a same-stream cluster as a ZERO-row count header.
 * A burst therefore always shows its first `PREVIEW_COUNT` records inline; the
 * remainder is reachable via an explicit "Show all M" action. This preserves
 * count==reachability AND content-visibility, and never dumps an N-row wall.
 */
export const PREVIEW_COUNT = 4;

export interface BurstGroup {
  /** All entries in this burst (not paginated further client-side). */
  entries: ExplorerFeedEntry[];
  /**
   * Whether the burst is fully expanded (all `entries` shown). Default `false` =
   * the `preview` state: only `preview` rows render, with a "Show all M" action.
   */
  expanded: boolean;
  /** Unique key for this burst: "<connectionId|connectorId>::<stream>". */
  key: string;
  /**
   * The first `PREVIEW_COUNT` entries — shown inline even when collapsed, so a
   * burst is NEVER a content-less header. (Always === entries.slice(0, PREVIEW_COUNT).)
   */
  preview: ExplorerFeedEntry[];
}

/**
 * One render unit inside a day group: either a standalone `single` entry or a
 * collapsed `burst`. Each carries its representative `latestAt` — the NEWEST time
 * the unit covers — so the day's units can be ordered newest-first regardless of
 * partition-discovery (first-seen) order. For a single this is the entry's own
 * `displayAt`; for a burst it is the newest member's `displayAt` (= `entries[0]`,
 * because the feed is pre-sorted descending). `latestAt` is `null` when the unit
 * has no parseable time (undated entry / empty `displayAt`).
 *
 * Prior art (docs/research/explore-burst-ordering-prior-art-2026-06-22.md):
 * Stream/Gmail/GitHub/Slack consensus — a group inherits its newest member's
 * timestamp and the day's render units (bursts AND singles) sort newest-first by
 * that. Rendering bursts-before-singles in first-seen order is the documented
 * GitHub-class anti-pattern that produced the live 23m→19m→31m scatter.
 */
export type DayRenderUnit =
  | { kind: "single"; entry: ExplorerFeedEntry; latestAt: string | null }
  | { kind: "burst"; burst: BurstGroup; latestAt: string | null };

export interface DayGroupWithBursts {
  /** Partitions at or above the burst threshold, rendered as groups. */
  bursts: BurstGroup[];
  /** UTC date string "YYYY-MM-DD", or "" for undated entries. */
  day: string;
  /** Human-readable label produced by `dayLabel`. */
  label: string;
  /** Entries below the burst threshold, rendered individually. */
  singles: ExplorerFeedEntry[];
  /**
   * The day's render units (singles + bursts) interleaved in DISPLAY order. This
   * is the SINGLE source of truth the canvas renders, so the view can never
   * re-introduce the bursts-before-singles misorder. `singles`/`bursts` are kept
   * for back-compat (counts, tests) but are NOT the render order.
   */
  units: DayRenderUnit[];
}

const partitionKey = (e: ExplorerFeedEntry): string => `${e.connectionId ?? e.connectorId}::${e.stream}`;

/**
 * The parseable representative time of an entry, or `null` when it has none
 * (undated entry / empty or non-string `displayAt`). Used to order render units
 * newest-first; `null`-time units sort AFTER all dated units.
 */
function entryLatestAt(e: ExplorerFeedEntry): string | null {
  if (typeof e.displayAt !== "string" || e.displayAt === "") {
    return null;
  }
  return Number.isNaN(Date.parse(e.displayAt)) ? null : e.displayAt;
}

/**
 * Sort entries newest-first by their representative time: dated descending, undated
 * (null-time) last, ties keep ORIGINAL order via a stable secondary index. Used to
 * make a burst's members newest-first INDEPENDENT of incoming order, so `latestAt`
 * (= entries[0]) and `preview` (= first PREVIEW_COUNT) are the actual newest members.
 */
function sortEntriesNewestFirst(entries: ExplorerFeedEntry[]): ExplorerFeedEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, at: entryLatestAt(entry) }))
    .sort((a, b) => {
      if (a.at === b.at) {
        return a.index - b.index;
      }
      if (a.at === null) {
        return 1;
      }
      if (b.at === null) {
        return -1;
      }
      return a.at > b.at ? -1 : 1;
    })
    .map(({ entry }) => entry);
}

/**
 * Order a day's render units newest-first by `latestAt` (descending). Undated
 * units (`latestAt === null`) sort AFTER all dated units. Ties (equal `latestAt`,
 * or two undated units) preserve the ORIGINAL input order via a stable secondary
 * index — no jitter, deterministic. Comparing the raw ISO strings is sound because
 * within a single day bucket every timestamp shares the same date prefix and ISO-8601
 * is lexically chronological.
 */
function orderDayUnits(units: DayRenderUnit[]): DayRenderUnit[] {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => {
      const aAt = a.unit.latestAt;
      const bAt = b.unit.latestAt;
      if (aAt === bAt) {
        return a.index - b.index; // stable tie-break: original feed order
      }
      if (aAt === null) {
        return 1; // a undated → after b
      }
      if (bAt === null) {
        return -1; // b undated → after a
      }
      if (aAt > bAt) {
        return -1; // newer first (descending)
      }
      if (aAt < bAt) {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ unit }) => unit);
}

/** Split one day's entries into singles + burst groups (≥ BURST_THRESHOLD per partition). */
function splitDayBursts(day: string, entries: ExplorerFeedEntry[], nowMs: number): DayGroupWithBursts {
  const partitionCounts = new Map<string, number>();
  for (const e of entries) {
    partitionCounts.set(partitionKey(e), (partitionCounts.get(partitionKey(e)) ?? 0) + 1);
  }
  const burstKeys = new Set<string>();
  for (const [pk, count] of partitionCounts) {
    if (count >= BURST_THRESHOLD) {
      burstKeys.add(pk);
    }
  }

  const singles: ExplorerFeedEntry[] = [];
  const burstByKey = new Map<string, BurstGroup>();
  const bursts: BurstGroup[] = [];
  // Units are collected in FIRST-SEEN order (a single at its own position, a burst
  // at its first member's position) so equal-time units keep their original feed
  // order after the stable sort below. Bursts are mutated in place as members are
  // appended; `preview` + `latestAt` are finalized once all members are collected.
  const orderedUnits: DayRenderUnit[] = [];
  for (const e of entries) {
    const pk = partitionKey(e);
    if (burstKeys.has(pk)) {
      const existing = burstByKey.get(pk);
      if (existing) {
        existing.entries.push(e);
      } else {
        // First member of this burst — reserve the burst's slot in feed order.
        const burst: BurstGroup = { key: pk, entries: [e], preview: [], expanded: false };
        burstByKey.set(pk, burst);
        bursts.push(burst);
        orderedUnits.push({ kind: "burst", burst, latestAt: null });
      }
    } else {
      singles.push(e);
      orderedUnits.push({ kind: "single", entry: e, latestAt: entryLatestAt(e) });
    }
  }

  // Finalize each burst. We SORT each burst's members newest-first ourselves rather
  // than trusting the caller to pre-sort: `latestAt` (the burst's sort key) and
  // `preview` (the rows shown by default) MUST be the newest member regardless of
  // incoming member order. Same dated-desc / undated-last / stable comparator as
  // render units, so a burst's members read newest-first and its header time == its
  // first rendered row == its sort key (self-consistent, monotonic on scan).
  for (const unit of orderedUnits) {
    if (unit.kind === "burst") {
      unit.burst.entries = sortEntriesNewestFirst(unit.burst.entries);
      unit.burst.preview = unit.burst.entries.slice(0, PREVIEW_COUNT);
      unit.latestAt = entryLatestAt(unit.burst.entries[0] as ExplorerFeedEntry);
    }
  }

  return { day, label: dayLabel(day, nowMs), singles, bursts, units: orderDayUnits(orderedUnits) };
}

/** Group entries into ordered day buckets (insertion order preserved → already-sorted feed). */
function groupDays(feed: readonly ExplorerFeedEntry[], nowMs: number): DayGroupWithBursts[] {
  const dayMap = new Map<string, ExplorerFeedEntry[]>();
  for (const entry of feed) {
    const day = typeof entry.displayAt === "string" ? entry.displayAt.slice(0, 10) : "";
    const bucket = dayMap.get(day) ?? [];
    bucket.push(entry);
    dayMap.set(day, bucket);
  }
  const days: DayGroupWithBursts[] = [];
  for (const [day, entries] of dayMap) {
    days.push(splitDayBursts(day, entries, nowMs));
  }
  return days;
}

/**
 * Group an already-sorted (descending-by-date) feed into day buckets with burst
 * detection. The `nowMs` parameter lets tests pin the clock for relative labels.
 */
export function groupFeedWithBursts(
  feed: readonly ExplorerFeedEntry[],
  nowMs: number = Date.now()
): DayGroupWithBursts[] {
  return groupDays(feed, nowMs);
}

/**
 * Day-group an already-sorted feed WITHOUT the inner burst collapse — every record
 * is a `single`, no `bursts`. Used inside the Upcoming section, which is ALREADY a
 * collapsed disclosure: re-bursting its loaded records would nest a second
 * "expand" inside the already-expanded section (the double-collapse clunk). The
 * Upcoming body is a flat, day-bucketed list of the records the owner asked to see.
 */
export function groupFeedDaysNoBursts(
  feed: readonly ExplorerFeedEntry[],
  nowMs: number = Date.now()
): DayGroupWithBursts[] {
  const dayMap = new Map<string, ExplorerFeedEntry[]>();
  for (const entry of feed) {
    const day = typeof entry.displayAt === "string" ? entry.displayAt.slice(0, 10) : "";
    const bucket = dayMap.get(day) ?? [];
    bucket.push(entry);
    dayMap.set(day, bucket);
  }
  const days: DayGroupWithBursts[] = [];
  for (const [day, entries] of dayMap) {
    // SCOPE GUARD: the Upcoming body is forward-chronological (soonest-first) by
    // design — do NOT newest-first re-sort it. Every entry is a flat single, and
    // `units` preserves the incoming order verbatim (no orderDayUnits call).
    const units: DayRenderUnit[] = entries.map((entry) => ({
      kind: "single",
      entry,
      latestAt: entryLatestAt(entry),
    }));
    days.push({ day, label: dayLabel(day, nowMs), singles: entries, bursts: [], units });
  }
  return days;
}

export interface PartitionedFeed {
  /** Today-and-earlier records, the normal newest-first day grouping. */
  past: DayGroupWithBursts[];
  /**
   * Future-dated records (day strictly after today), FORWARD-chronological
   * (soonest future first) and day-bucketed. Rendered as a collapsed-by-default
   * "Upcoming" section at the top of the feed so scheduled items (e.g. YNAB future
   * budget months) never sit above today's actual activity. Prior art:
   * docs/research/explore-future-dated-records-prior-art-2026-06-21.md.
   */
  upcoming: DayGroupWithBursts[];
  /** Total future records across all upcoming groups (for the collapsed count). */
  upcomingCount: number;
}

/**
 * Partition an already-sorted (descending) feed into an Upcoming (future) section
 * and the normal past/today feed. The main timeline is clamped to today/now; future
 * rows move into a forward-chronological Upcoming bucket. Undated entries ("" day)
 * stay in `past` (they are not "future").
 */
export function partitionFeedByTime(feed: readonly ExplorerFeedEntry[], nowMs: number = Date.now()): PartitionedFeed {
  const cutoff = todayKey(nowMs);
  const futureEntries: ExplorerFeedEntry[] = [];
  const pastEntries: ExplorerFeedEntry[] = [];
  for (const entry of feed) {
    const day = typeof entry.displayAt === "string" ? entry.displayAt.slice(0, 10) : "";
    if (day !== "" && day > cutoff) {
      futureEntries.push(entry);
    } else {
      pastEntries.push(entry);
    }
  }

  // Upcoming is FORWARD-chronological (soonest first), so re-sort ascending; the
  // incoming feed is descending (newest first), which for the future tail means
  // farthest-out first — reverse it to soonest-first (Things/Todoist convention).
  const dayOf = (e: ExplorerFeedEntry): string => (typeof e.displayAt === "string" ? e.displayAt : "");
  const upcomingSorted = [...futureEntries].sort((a, b) => dayOf(a).localeCompare(dayOf(b)));

  const upcoming = groupDays(upcomingSorted, nowMs);
  const past = groupDays(pastEntries, nowMs);
  return { upcoming, upcomingCount: futureEntries.length, past };
}
