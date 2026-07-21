/**
 * Tests for explore-feed-grouping.ts
 *
 * Covers:
 *   - dayLabel: Today/Yesterday relative labels + full weekday format for older days
 *   - groupFeedWithBursts: day bucketing, burst detection at threshold boundary,
 *     partition key (connectionId fallback to connectorId), singles vs bursts split
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";
import {
  BURST_THRESHOLD,
  type DayRenderUnit,
  dayLabel,
  groupFeedDaysNoBursts,
  groupFeedWithBursts,
  isFutureDay,
  PREVIEW_COUNT,
  partitionFeedByTime,
} from "./explore-feed-grouping.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal ExplorerFeedEntry stub. */
function entry(
  opts: {
    displayAt?: string;
    connectionId?: string | null;
    connectorId?: string;
    stream?: string;
    recordId?: string;
  } = {}
): ExplorerFeedEntry {
  // Distinguish "not passed" (undefined) from explicitly null so callers can
  // test the null-connectionId fallback path.
  const connectionId = "connectionId" in opts ? (opts.connectionId ?? null) : "cin_1";
  return {
    blobAffordance: undefined,
    connectionDisplayName: null,
    connectionId,
    connectorId: opts.connectorId ?? "whatsapp",
    displayAt: opts.displayAt ?? "2026-06-19T12:00:00Z",
    displayIsSemantic: false,
    emittedAt: opts.displayAt ?? "2026-06-19T12:00:00Z",
    recordId: opts.recordId ?? "rec_1",
    stream: opts.stream ?? "messages",
  };
}

/** Fixed "now" for clock pinning: 2026-06-19T15:00:00Z */
const NOW_MS = Date.parse("2026-06-19T15:00:00Z");
/** ISO date that equals "today" given NOW_MS */
const TODAY = "2026-06-19";
/** ISO date that equals "yesterday" given NOW_MS */
const YESTERDAY = "2026-06-18";

// ─── dayLabel ─────────────────────────────────────────────────────────────────

test("dayLabel returns 'Today' for today's UTC date", () => {
  assert.equal(dayLabel(TODAY, NOW_MS), "Today");
});

test("dayLabel returns 'Yesterday' for the previous UTC date", () => {
  assert.equal(dayLabel(YESTERDAY, NOW_MS), "Yesterday");
});

test("dayLabel returns full weekday+date for older days", () => {
  // 2026-06-17 is a Wednesday (UTC)
  const label = dayLabel("2026-06-17", NOW_MS);
  assert.ok(label.includes("Wednesday"), `expected Wednesday in "${label}"`);
  assert.ok(label.includes("June"), `expected June in "${label}"`);
  assert.ok(label.includes("17"), `expected 17 in "${label}"`);
});

test("dayLabel returns 'Undated' for empty string", () => {
  assert.equal(dayLabel("", NOW_MS), "Undated");
});

test("dayLabel returns 'Undated' for unparseable string", () => {
  assert.equal(dayLabel("not-a-date", NOW_MS), "Undated");
});

// ─── groupFeedWithBursts — basic grouping ─────────────────────────────────────

test("groupFeedWithBursts: empty feed returns empty array", () => {
  assert.deepEqual(groupFeedWithBursts([], NOW_MS), []);
});

test("groupFeedWithBursts: single entry produces one day group with one single", () => {
  const e = entry({ displayAt: `${TODAY}T10:00:00Z` });
  const groups = groupFeedWithBursts([e], NOW_MS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.day, TODAY);
  assert.equal(groups[0]?.label, "Today");
  assert.equal(groups[0]?.singles.length, 1);
  assert.equal(groups[0]?.bursts.length, 0);
});

test("groupFeedWithBursts: entries across two days produce two day groups", () => {
  const e1 = entry({ displayAt: `${TODAY}T10:00:00Z`, recordId: "r1" });
  const e2 = entry({ displayAt: `${YESTERDAY}T10:00:00Z`, recordId: "r2" });
  const groups = groupFeedWithBursts([e1, e2], NOW_MS);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.day, TODAY);
  assert.equal(groups[1]?.day, YESTERDAY);
});

// ─── groupFeedWithBursts — burst threshold ────────────────────────────────────

test("groupFeedWithBursts: exactly BURST_THRESHOLD-1 entries from one partition => singles only", () => {
  const n = BURST_THRESHOLD - 1;
  const entries = Array.from({ length: n }, (_, i) =>
    entry({ displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`, recordId: `r${i}`, stream: "messages" })
  );
  const groups = groupFeedWithBursts(entries, NOW_MS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.singles.length, n);
  assert.equal(groups[0]?.bursts.length, 0);
});

test("groupFeedWithBursts: exactly BURST_THRESHOLD entries from one partition => one burst group", () => {
  const n = BURST_THRESHOLD;
  const entries = Array.from({ length: n }, (_, i) =>
    entry({ displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`, recordId: `r${i}`, stream: "messages" })
  );
  const groups = groupFeedWithBursts(entries, NOW_MS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.singles.length, 0);
  assert.equal(groups[0]?.bursts.length, 1);
  assert.equal(groups[0]?.bursts[0]?.entries.length, n);
  // Burst group starts collapsed
  assert.equal(groups[0]?.bursts[0]?.expanded, false);
});

test("groupFeedWithBursts: burst key uses connectionId when present", () => {
  const n = BURST_THRESHOLD;
  const entries = Array.from({ length: n }, (_, i) =>
    entry({
      displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`,
      recordId: `r${i}`,
      connectionId: "cin_abc",
      stream: "messages",
    })
  );
  const groups = groupFeedWithBursts(entries, NOW_MS);
  assert.equal(groups[0]?.bursts[0]?.key, "cin_abc::messages");
});

test("groupFeedWithBursts: burst key falls back to connectorId when connectionId is null", () => {
  const n = BURST_THRESHOLD;
  const entries = Array.from({ length: n }, (_, i) =>
    entry({
      displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`,
      recordId: `r${i}`,
      connectionId: null,
      connectorId: "whatsapp",
      stream: "chats",
    })
  );
  const groups = groupFeedWithBursts(entries, NOW_MS);
  assert.equal(groups[0]?.bursts[0]?.key, "whatsapp::chats");
});

// ─── groupFeedWithBursts — mixed singles + bursts ────────────────────────────

test("groupFeedWithBursts: burst partition is separated from singles in same day", () => {
  const burstEntries = Array.from({ length: BURST_THRESHOLD }, (_, i) =>
    entry({
      displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`,
      recordId: `burst_${i}`,
      connectionId: "cin_wa",
      stream: "messages",
    })
  );
  // Two singles from a different (connection, stream) partition
  const singleEntries = [
    entry({ displayAt: `${TODAY}T11:00:00Z`, recordId: "s1", connectionId: "cin_gmail", stream: "emails" }),
    entry({ displayAt: `${TODAY}T11:01:00Z`, recordId: "s2", connectionId: "cin_gmail", stream: "emails" }),
  ];
  const groups = groupFeedWithBursts([...burstEntries, ...singleEntries], NOW_MS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.bursts.length, 1);
  // Singles are the gmail entries (2 < BURST_THRESHOLD)
  assert.equal(groups[0]?.singles.length, 2);
});

test("groupFeedWithBursts: two burst partitions in same day produce two burst groups", () => {
  const mkBurst = (stream: string, connId: string) =>
    Array.from({ length: BURST_THRESHOLD }, (_, i) =>
      entry({
        displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`,
        recordId: `${stream}_${i}`,
        connectionId: connId,
        stream,
      })
    );
  const groups = groupFeedWithBursts([...mkBurst("messages", "cin_wa"), ...mkBurst("calls", "cin_wa")], NOW_MS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.bursts.length, 2);
  assert.equal(groups[0]?.singles.length, 0);
});

test("groupFeedWithBursts: bursts in one day, singles in another day", () => {
  const burstEntries = Array.from({ length: BURST_THRESHOLD }, (_, i) =>
    entry({
      displayAt: `${TODAY}T10:00:${String(i).padStart(2, "0")}Z`,
      recordId: `b${i}`,
      connectionId: "cin_wa",
      stream: "messages",
    })
  );
  const singles = [
    entry({ displayAt: `${YESTERDAY}T09:00:00Z`, recordId: "y1", connectionId: "cin_gmail", stream: "emails" }),
  ];
  const groups = groupFeedWithBursts([...burstEntries, ...singles], NOW_MS);
  assert.equal(groups.length, 2);
  const todayGroup = groups.find((g) => g.day === TODAY);
  const yestGroup = groups.find((g) => g.day === YESTERDAY);
  assert.ok(todayGroup);
  assert.ok(yestGroup);
  assert.equal(todayGroup.bursts.length, 1);
  assert.equal(yestGroup.singles.length, 1);
});

// ─── dayLabel: year + Tomorrow ────────────────────────────────────────────────

const TOMORROW = "2026-06-20";

test("dayLabel includes the YEAR for non-relative days (multi-year corpus disambiguation)", () => {
  // 2025-04-20 vs 2026-04-20 must be distinguishable.
  const label = dayLabel("2025-04-20", NOW_MS);
  assert.ok(label.includes("2025"), `expected year 2025 in "${label}"`);
  assert.ok(label.includes("April"), `expected April in "${label}"`);
});

test("dayLabel returns 'Tomorrow' for the next UTC date", () => {
  assert.equal(dayLabel(TOMORROW, NOW_MS), "Tomorrow");
});

// ─── isFutureDay ──────────────────────────────────────────────────────────────

test("isFutureDay is true strictly after today, false for today/past/empty", () => {
  assert.equal(isFutureDay(TOMORROW, NOW_MS), true);
  assert.equal(isFutureDay("2026-08-01", NOW_MS), true);
  assert.equal(isFutureDay(TODAY, NOW_MS), false);
  assert.equal(isFutureDay(YESTERDAY, NOW_MS), false);
  assert.equal(isFutureDay("", NOW_MS), false);
});

// ─── partitionFeedByTime ──────────────────────────────────────────────────────

test("partitionFeedByTime splits future records into Upcoming, leaving today/past in the main feed", () => {
  const feed = [
    // Future (YNAB-shaped budget months), arriving newest-first (farthest-out first)
    entry({ displayAt: "2026-08-01T00:00:00Z", recordId: "aug", connectorId: "ynab", stream: "months" }),
    entry({ displayAt: "2026-07-01T00:00:00Z", recordId: "jul", connectorId: "ynab", stream: "months" }),
    // Today + past
    entry({ displayAt: `${TODAY}T14:00:00Z`, recordId: "t1", connectorId: "claude-code" }),
    entry({ displayAt: `${YESTERDAY}T09:00:00Z`, recordId: "y1", connectorId: "gmail", stream: "emails" }),
  ];
  const { upcoming, upcomingCount, past } = partitionFeedByTime(feed, NOW_MS);

  assert.equal(upcomingCount, 2, "two future records");
  // Upcoming is FORWARD-chronological: July (soonest) before August.
  assert.deepEqual(
    upcoming.map((g) => g.day),
    ["2026-07-01", "2026-08-01"]
  );
  // Past keeps newest-first: today before yesterday.
  assert.deepEqual(
    past.map((g) => g.day),
    [TODAY, YESTERDAY]
  );
  // No future record leaked into the main feed.
  for (const g of past) {
    assert.ok(g.day <= TODAY, `past group ${g.day} must not be future`);
  }
});

test("partitionFeedByTime: no future records → empty Upcoming, full feed in past", () => {
  const feed = [
    entry({ displayAt: `${TODAY}T14:00:00Z`, recordId: "t1" }),
    entry({ displayAt: `${YESTERDAY}T09:00:00Z`, recordId: "y1" }),
  ];
  const { upcoming, upcomingCount, past } = partitionFeedByTime(feed, NOW_MS);
  assert.equal(upcomingCount, 0);
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 2);
});

test("partitionFeedByTime: undated ('' day) records stay in past, never treated as future", () => {
  const feed = [
    { ...entry({ recordId: "u1" }), displayAt: "" } as ExplorerFeedEntry,
    entry({ displayAt: `${TODAY}T14:00:00Z`, recordId: "t1" }),
  ];
  const { upcoming, upcomingCount, past } = partitionFeedByTime(feed, NOW_MS);
  assert.equal(upcomingCount, 0);
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 2, "today group + undated group both in past");
});

// ─── groupFeedDaysNoBursts: flat days for the Upcoming body (no double-collapse) ──

test("groupFeedDaysNoBursts: a same-partition day over the burst threshold stays FLAT (no inner burst)", () => {
  // 64 records of one (connection, stream) on one day — far over BURST_THRESHOLD.
  // groupFeedWithBursts would collapse them into a burst; the Upcoming body must NOT
  // (it is already a collapsed disclosure — a second "expand" inside it is the clunk).
  const day = `${TODAY}T10:00:00Z`;
  const feed = Array.from({ length: BURST_THRESHOLD + 54 }, (_, i) =>
    entry({ displayAt: day, recordId: `m${i}`, stream: "month_categories", connectionId: "cin_ynab" })
  );

  // Control: the normal grouping DOES burst (proving the input is burst-eligible).
  const bursted = groupFeedWithBursts(feed, NOW_MS);
  assert.equal(bursted.length, 1, "one day group");
  assert.equal(bursted[0]?.bursts.length, 1, "control: normal grouping collapses into a burst");

  // The Upcoming variant: zero bursts, every record a flat single.
  const flat = groupFeedDaysNoBursts(feed, NOW_MS);
  assert.equal(flat.length, 1, "one day group");
  assert.equal(flat[0]?.bursts.length, 0, "Upcoming body must NOT re-burst (no nested expand)");
  assert.equal(flat[0]?.singles.length, feed.length, "every loaded upcoming record is a flat single");
});

test("groupFeedDaysNoBursts: still buckets by day, preserving order", () => {
  const feed = [
    entry({ displayAt: `${TODAY}T10:00:00Z`, recordId: "a" }),
    entry({ displayAt: `${TODAY}T11:00:00Z`, recordId: "b" }),
    entry({ displayAt: `${TOMORROW}T09:00:00Z`, recordId: "c" }),
  ];
  const days = groupFeedDaysNoBursts(feed, NOW_MS);
  assert.equal(days.length, 2, "two day buckets (today, tomorrow)");
  assert.equal(days[0]?.singles.length, 2);
  assert.equal(days[1]?.singles.length, 1);
  assert.ok(
    days.every((d) => d.bursts.length === 0),
    "no bursts in any day"
  );
});

// ─── Burst preview-content-by-default (D1 / review-required) ───────────────────
//
// SLVP rule (review-gated 2026-06-22): a burst must NEVER render as a
// content-less count header. The grouping layer guarantees this by ALWAYS
// populating `preview` with the first PREVIEW_COUNT entries; the renderer shows
// `preview` even when collapsed. These tests pin that grouping+render contract.

test("8.1: every burst's preview length == min(entries.length, PREVIEW_COUNT) and is > 0", () => {
  // Mix burst sizes: exactly threshold, just over, and far over PREVIEW_COUNT.
  const day = `${TODAY}T10:00:00Z`;
  const mk = (stream: string, n: number) =>
    Array.from({ length: n }, (_, i) => entry({ displayAt: day, recordId: `${stream}-${i}`, stream }));
  const feed = [
    ...mk("messages", BURST_THRESHOLD), // == threshold (10)
    ...mk("reactions", BURST_THRESHOLD + 1), // just over
    ...mk("media", 200), // far over
  ];
  const days = groupFeedWithBursts(feed, NOW_MS);
  const bursts = days.flatMap((d) => d.bursts);
  assert.equal(bursts.length, 3, "three same-stream clusters each crossed BURST_THRESHOLD");
  for (const burst of bursts) {
    const expected = Math.min(burst.entries.length, PREVIEW_COUNT);
    assert.equal(
      burst.preview.length,
      expected,
      `preview must be min(entries=${burst.entries.length}, PREVIEW_COUNT=${PREVIEW_COUNT})`
    );
    assert.ok(burst.preview.length > 0, "a burst NEVER previews zero rows (no content-less header)");
    // The preview must be the literal head of entries (what the row renderer shows).
    assert.deepEqual(
      burst.preview.map((e) => e.recordId),
      burst.entries.slice(0, PREVIEW_COUNT).map((e) => e.recordId),
      "preview is the first PREVIEW_COUNT entries in order"
    );
  }
});

test("8.2: a day-group that crosses BURST_THRESHOLD still yields visible content rows by default (preview), not a header-only state", () => {
  // Accumulation pushes one (connection, stream) past the threshold — the exact
  // load-more scenario that previously produced a zero-row collapsed burst.
  const day = `${TODAY}T10:00:00Z`;
  const feed = Array.from({ length: BURST_THRESHOLD + 86 }, (_, i) =>
    entry({ displayAt: day, recordId: `m${i}`, stream: "messages", connectionId: "cin_wa" })
  );
  const days = groupFeedWithBursts(feed, NOW_MS);
  assert.equal(days.length, 1, "one day group");
  const burst = days[0]?.bursts[0];
  assert.ok(burst, "the over-threshold partition collapsed into a burst");
  // The render contract: the DEFAULT (collapsed) view renders `burst.preview`. If
  // preview were empty this would be a header-only count wall (the live bug).
  assert.ok(
    (burst?.preview.length ?? 0) > 0,
    "default-rendered burst contains visible content rows, not a header-only/zero-row state"
  );
  assert.equal(burst?.expanded, false, "default is the collapsed/preview state, not full expansion");
});

test("8.3: preview-reachability — the burst count label number == burst.entries.length (what 'Show all M' reaches), never a larger hidden total", () => {
  const day = `${TODAY}T10:00:00Z`;
  const loaded = BURST_THRESHOLD + 33;
  const feed = Array.from({ length: loaded }, (_, i) =>
    entry({ displayAt: day, recordId: `m${i}`, stream: "messages", connectionId: "cin_wa" })
  );
  const burst = groupFeedWithBursts(feed, NOW_MS)[0]?.bursts[0];
  assert.ok(burst, "burst exists");
  // The renderer labels the burst `loaded.toLocaleString()` where loaded =
  // burst.entries.length, and "Show all M" reveals exactly burst.entries. So the
  // displayed count == the reachable set; it can never imply a larger hidden total.
  assert.equal(burst?.entries.length, loaded, "count label source == loaded entries");
  // hiddenCount the toggle exposes = loaded - preview; expanding reaches all entries.
  const hiddenCount = (burst?.entries.length ?? 0) - (burst?.preview.length ?? 0);
  assert.equal(
    (burst?.preview.length ?? 0) + hiddenCount,
    burst?.entries.length,
    "preview + hidden == entries: every counted record is reachable, no phantom total"
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Burst-ordering fix (Part A, 2026-06-22) — the live 23m→19m→31m across-burst bug.
//
// Prior art (docs/research/explore-burst-ordering-prior-art-2026-06-22.md):
// a group inherits its NEWEST member's timestamp; the day's render UNITS (bursts
// AND singles) sort newest-first by that; members stay newest-first inside a burst.
// The grouping layer now exposes an ordered `units` list as the render source of
// truth; these tests pin its ordering, tie/undated handling, and the invariant.
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a burst of `count` entries for one (connection, stream), all at `iso`, in
 *  feed order (descending caller-controlled). Crosses BURST_THRESHOLD by default. */
function burstAt(opts: { stream: string; connectionId: string; isos: string[] }): ExplorerFeedEntry[] {
  return opts.isos.map((iso, i) =>
    entry({
      displayAt: iso,
      recordId: `${opts.stream}-${i}`,
      connectionId: opts.connectionId,
      stream: opts.stream,
    })
  );
}

/** All entries at the same iso (newest member = entries[0]); used when only the
 *  burst's latest member matters for ordering. */
function burstNewestAt(stream: string, connectionId: string, newestIso: string): ExplorerFeedEntry[] {
  // 10 members at the same instant => latestAt = newestIso, crosses BURST_THRESHOLD.
  return burstAt({ stream, connectionId, isos: Array.from({ length: BURST_THRESHOLD }, () => newestIso) });
}

/** The `latestAt` of each unit, in render order. */
function unitLatestAts(units: readonly DayRenderUnit[]): (string | null)[] {
  return units.map((u) => u.latestAt);
}

test("burst order: three same-day bursts (newest members 23m/19m/31m ago) sort NEWEST-first 19m→23m→31m", () => {
  // NOW_MS = 2026-06-19T15:00:00Z. "23m ago" = 14:37, "19m ago" = 14:41, "31m ago" = 14:29.
  // Newest-first (smallest minutes-ago first): 19m (14:41) → 23m (14:37) → 31m (14:29).
  const ago23 = "2026-06-19T14:37:00Z";
  const ago19 = "2026-06-19T14:41:00Z";
  const ago31 = "2026-06-19T14:29:00Z";
  // Feed arrives in the BAD order Tim saw: A(23m) first, then B(19m), then C(31m).
  const feed = [
    ...burstNewestAt("codex_messages", "cin_codex", ago23), // A
    ...burstNewestAt("codex_calls", "cin_codex2", ago19), // B
    ...burstNewestAt("cc_messages", "cin_cc", ago31), // C
  ];
  const groups = groupFeedWithBursts(feed, NOW_MS);
  assert.equal(groups.length, 1, "one day group");
  const units = groups[0]?.units ?? [];
  assert.equal(units.length, 3, "three burst units");
  assert.ok(
    units.every((u) => u.kind === "burst"),
    "all units are bursts"
  );
  // Post-fix render order is newest-first: B(19m) → A(23m) → C(31m).
  assert.deepEqual(unitLatestAts(units), [ago19, ago23, ago31], "units sort newest-first by latestAt");
  // The bad first-seen order [ago23, ago19, ago31] is NO LONGER what renders.
  assert.notDeepEqual(unitLatestAts(units), [ago23, ago19, ago31], "first-seen (buggy) order is gone");
});

test("burst latestAt = NEWEST member even when burst members arrive shuffled (not pre-sorted)", () => {
  // End-review P0: latestAt must be the newest member INDEPENDENT of input
  // order — the grouping must not rely on the feed being pre-sorted descending.
  // Members deliberately out of order; the newest is 14:41, the oldest 14:32.
  const isos = [
    "2026-06-19T14:32:00Z",
    "2026-06-19T14:41:00Z", // newest
    "2026-06-19T14:35:00Z",
    "2026-06-19T14:39:00Z",
    "2026-06-19T14:38:00Z",
    "2026-06-19T14:37:00Z",
    "2026-06-19T14:36:00Z",
    "2026-06-19T14:34:00Z",
    "2026-06-19T14:33:00Z",
    "2026-06-19T14:40:00Z",
  ];
  const feed = burstAt({ stream: "messages", connectionId: "cin_shuffled", isos });
  const groups = groupFeedWithBursts(feed, NOW_MS);
  const units = groups[0]?.units ?? [];
  assert.equal(units.length, 1, "one burst unit");
  const unit = units[0];
  assert.ok(unit && unit.kind === "burst", "the unit is a burst");
  // latestAt is the NEWEST member, not the first array member.
  assert.equal(unit.latestAt, "2026-06-19T14:41:00Z", "latestAt = newest member, not entries[0] of input");
  // Members are sorted newest-first, so preview shows the newest records.
  const entryAts = unit.burst.entries.map((e) => e.displayAt);
  const sortedDesc = [...isos].sort((a, b) => (a > b ? -1 : 1));
  assert.deepEqual(entryAts, sortedDesc, "burst members are newest-first regardless of input order");
  assert.equal(unit.burst.preview[0]?.displayAt, "2026-06-19T14:41:00Z", "preview leads with the newest member");
});

test("burst order: a single interleaves with bursts by time (single at 25m between a 23m burst and a 31m burst)", () => {
  // 23m → 14:37, 25m → 14:35, 31m → 14:29. Newest-first: 23m-burst, 25m-single, 31m-burst.
  const ago23 = "2026-06-19T14:37:00Z";
  const ago25 = "2026-06-19T14:35:00Z";
  const ago31 = "2026-06-19T14:29:00Z";
  const feed = [
    // Feed order deliberately not display order: the single arrives first, the older
    // burst before the newer one — the fix must still produce strict DESC.
    entry({ displayAt: ago25, recordId: "single-25", connectionId: "cin_gmail", stream: "emails" }),
    ...burstNewestAt("cc_messages", "cin_cc", ago31), // older burst
    ...burstNewestAt("codex_messages", "cin_codex", ago23), // newer burst
  ];
  const groups = groupFeedWithBursts(feed, NOW_MS);
  const units = groups[0]?.units ?? [];
  assert.equal(units.length, 3, "two bursts + one single");
  assert.deepEqual(
    units.map((u) => u.kind),
    ["burst", "single", "burst"],
    "the 25m single sits BETWEEN the 23m burst and the 31m burst (no bursts-before-singles)"
  );
  assert.deepEqual(unitLatestAts(units), [ago23, ago25, ago31], "strict newest-first across bursts AND singles");
});

test("burst order: members within a burst stay newest-first (descending input preserved, not reordered)", () => {
  const isosDesc = [
    "2026-06-19T14:41:00Z",
    "2026-06-19T14:40:00Z",
    "2026-06-19T14:39:00Z",
    "2026-06-19T14:38:00Z",
    "2026-06-19T14:37:00Z",
    "2026-06-19T14:36:00Z",
    "2026-06-19T14:35:00Z",
    "2026-06-19T14:34:00Z",
    "2026-06-19T14:33:00Z",
    "2026-06-19T14:32:00Z",
  ];
  const feed = burstAt({ stream: "messages", connectionId: "cin_wa", isos: isosDesc });
  const burst = groupFeedWithBursts(feed, NOW_MS)[0]?.units[0];
  assert.ok(burst, "the over-threshold partition produced a unit");
  if (burst.kind !== "burst") {
    throw new Error("expected a burst unit");
  }
  assert.deepEqual(
    burst.burst.entries.map((e) => e.displayAt),
    isosDesc,
    "burst members keep their newest-first (descending) input order"
  );
  assert.equal(burst.latestAt, isosDesc[0], "burst latestAt = newest member = entries[0].displayAt");
});

test("burst order: equal-latestAt units keep deterministic ORIGINAL feed order (stable tie-break, no jitter)", () => {
  const sameIso = "2026-06-19T14:30:00Z";
  // Two bursts and a single all share the SAME latestAt; they must render in the
  // order they first appeared in the feed: burstX, single, burstY.
  const feed = [
    ...burstNewestAt("x", "cin_x", sameIso),
    entry({ displayAt: sameIso, recordId: "tie-single", connectionId: "cin_s", stream: "single" }),
    ...burstNewestAt("y", "cin_y", sameIso),
  ];
  const units = groupFeedWithBursts(feed, NOW_MS)[0]?.units ?? [];
  assert.equal(units.length, 3);
  // All same time → original order preserved exactly.
  const shape = units.map((u) => (u.kind === "burst" ? u.burst.key : `single:${u.entry.recordId}`));
  assert.deepEqual(shape, ["cin_x::x", "single:tie-single", "cin_y::y"], "equal-time units keep first-seen order");
  // Run twice: deterministic (no Math.random / Date.now in the sort).
  const again = groupFeedWithBursts(feed, NOW_MS)[0]?.units ?? [];
  assert.deepEqual(
    again.map((u) => (u.kind === "burst" ? u.burst.key : `single:${u.entry.recordId}`)),
    shape,
    "ordering is deterministic across runs"
  );
});

test("burst order: an undated unit sorts AFTER all dated units within the day (no crash)", () => {
  const ago20 = "2026-06-19T14:40:00Z";
  const feed = [
    // Undated single arrives FIRST in the feed but must sink to the bottom of the day.
    { ...entry({ recordId: "undated", connectionId: "cin_u", stream: "misc" }), displayAt: "" } as ExplorerFeedEntry,
    ...burstNewestAt("dated", "cin_d", ago20),
    entry({ displayAt: ago20, recordId: "dated-single", connectionId: "cin_ds", stream: "emails" }),
  ];
  const groups = groupFeedWithBursts(feed, NOW_MS);
  // The undated "" day buckets separately from the 2026-06-19 day. Within the DATED
  // day, the undated entry is absent; assert no crash + the dated day orders fine.
  const datedDay = groups.find((g) => g.day === "2026-06-19");
  assert.ok(datedDay, "dated day group exists");
  assert.ok(
    datedDay?.units.every((u) => u.latestAt !== null),
    "dated day has no null-time units"
  );

  // Now force an undated unit to share a day with dated units (unparseable displayAt
  // that still slices to a same-day prefix is impossible, so construct directly).
  const mixed = [
    entry({ displayAt: ago20, recordId: "d1", connectionId: "cin_a", stream: "a" }),
    {
      ...entry({ recordId: "u1", connectionId: "cin_b", stream: "b" }),
      displayAt: "2026-06-19TBROKEN",
    } as ExplorerFeedEntry,
    entry({ displayAt: "2026-06-19T14:41:00Z", recordId: "d2", connectionId: "cin_c", stream: "c" }),
  ];
  const mixedDay = groupFeedWithBursts(mixed, NOW_MS).find((g) => g.day === "2026-06-19");
  assert.ok(mixedDay, "mixed same-day group exists");
  const ats = unitLatestAts(mixedDay?.units);
  // Dated units (descending) first, the undated/unparseable one last.
  assert.deepEqual(
    ats,
    ["2026-06-19T14:41:00Z", ago20, null],
    "dated units order newest-first; the undated unit sorts last"
  );
});

test("burst order SCOPE GUARD: groupFeedDaysNoBursts (Upcoming path) stays FLAT + forward-chron — no newest-first re-sort", () => {
  // Upcoming arrives soonest-first (forward-chron). The units must MIRROR that input
  // order verbatim — never get newest-first re-sorted like the past feed.
  const feed = [
    entry({ displayAt: "2026-06-20T09:00:00Z", recordId: "soon", connectorId: "ynab", stream: "months" }),
    entry({ displayAt: "2026-06-20T11:00:00Z", recordId: "later-same-day", connectorId: "ynab", stream: "months" }),
    entry({ displayAt: "2026-07-01T09:00:00Z", recordId: "next-month", connectorId: "ynab", stream: "months" }),
  ];
  const days = groupFeedDaysNoBursts(feed, NOW_MS);
  // Days stay in input (forward-chron) order, every unit a single, no bursts.
  assert.deepEqual(
    days.map((d) => d.day),
    ["2026-06-20", "2026-07-01"],
    "Upcoming day buckets stay forward-chron (soonest first)"
  );
  for (const d of days) {
    assert.ok(d.bursts.length === 0, "Upcoming never bursts");
    assert.ok(
      d.units.every((u) => u.kind === "single"),
      "every Upcoming unit is a single"
    );
  }
  // Within 2026-06-20 the two entries keep their INPUT order (09:00 then 11:00) — a
  // newest-first sort would have flipped them to 11:00 then 09:00. Prove it did NOT.
  const day20 = days.find((d) => d.day === "2026-06-20");
  assert.ok(day20, "the 2026-06-20 day group exists");
  assert.deepEqual(
    unitLatestAts(day20.units),
    ["2026-06-20T09:00:00Z", "2026-06-20T11:00:00Z"],
    "Upcoming within-day order is the forward-chron INPUT order, NOT newest-first"
  );
});

test("burst order INVARIANT: scanning units top-to-bottom, latestAt is monotonic non-increasing (dated), undated last", () => {
  // A realistic mixed day: bursts + singles at scattered times, fed in non-display order.
  const feed = [
    entry({ displayAt: "2026-06-19T10:00:00Z", recordId: "s-10", connectionId: "cin_1a", stream: "a" }),
    ...burstNewestAt("b1", "cin_b1", "2026-06-19T14:00:00Z"),
    entry({ displayAt: "2026-06-19T12:30:00Z", recordId: "s-1230", connectionId: "cin_2a", stream: "b" }),
    ...burstNewestAt("b2", "cin_b2", "2026-06-19T08:15:00Z"),
    { ...entry({ recordId: "u", connectionId: "cin_u", stream: "u" }), displayAt: "" } as ExplorerFeedEntry,
    ...burstNewestAt("b3", "cin_b3", "2026-06-19T13:45:00Z"),
  ];
  // Put the undated entry into the SAME day as the dated ones via a broken-but-prefixed
  // displayAt so it shares the 2026-06-19 bucket.
  feed[4] = {
    ...entry({ recordId: "u", connectionId: "cin_u", stream: "u" }),
    displayAt: "2026-06-19Tnonsense",
  } as ExplorerFeedEntry;
  const day = groupFeedWithBursts(feed, NOW_MS).find((g) => g.day === "2026-06-19");
  assert.ok(day, "the 2026-06-19 day group exists");
  const ats = unitLatestAts(day.units);
  let sawNull = false;
  let prevDated: string | null = null;
  for (const at of ats) {
    if (at === null) {
      sawNull = true; // every subsequent unit may also be null, but never dated again
      continue;
    }
    assert.ok(!sawNull, "a dated unit must never follow an undated unit (undated sorts last)");
    if (prevDated !== null) {
      assert.ok(at <= prevDated, `monotonic non-increasing: ${at} must be <= previous ${prevDated}`);
    }
    prevDated = at;
  }
});
