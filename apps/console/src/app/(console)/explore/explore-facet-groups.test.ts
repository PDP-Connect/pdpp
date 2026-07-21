import assert from "node:assert/strict";
import test from "node:test";
import type { ExplorerConnectionFacet, ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";
import {
  computeSourceGroupedStreamFacets,
  filterSourceGroups,
  totalVisibleStreamFacets,
} from "./explore-facet-groups.ts";

// ── Inline fixtures (the repo's tests build literals; no shared factory) ──

function con(
  connectionId: string,
  connectorId: string,
  displayName: string,
  streams: string[]
): ExplorerConnectionFacet {
  return { connectionId, connectorId, displayName, streams };
}

function entry(connectionId: string, stream: string): ExplorerFeedEntry {
  return {
    connectionDisplayName: null,
    connectionId,
    connectorId: stream,
    displayAt: "2026-06-22T00:00:00.000Z",
    displayIsSemantic: false,
    emittedAt: "2026-06-22T00:00:00.000Z",
    recordId: `${connectionId}:${stream}:${Math.random()}`,
    stream,
  };
}

const ALL: (e: ExplorerFeedEntry) => boolean = () => true;

// Two sources that BOTH own a `messages` stream — the misattribution trap.
const SLACK = con("conn_slack", "slack", "Slack — Work", ["messages", "channels"]);
const IMESSAGE = con("conn_imessage", "imessage", "iMessage", ["messages", "attachments"]);

test("per-source loaded count = loaded feed rows for THAT (connection, stream), never a global tally", () => {
  // 3 slack messages, 1 imessage message, 2 slack channels.
  const feed: ExplorerFeedEntry[] = [
    entry("conn_slack", "messages"),
    entry("conn_slack", "messages"),
    entry("conn_slack", "messages"),
    entry("conn_imessage", "messages"),
    entry("conn_slack", "channels"),
    entry("conn_slack", "channels"),
  ];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK, IMESSAGE],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });

  const slack = groups.find((g) => g.connectionId === "conn_slack");
  const imessage = groups.find((g) => g.connectionId === "conn_imessage");
  assert.ok(slack && imessage);

  // The SAME stream name `messages` carries its OWN per-source count, not a
  // duplicated global one: 3 under Slack, 1 under iMessage (NOT 4 under each).
  const slackMessages = slack.streams.find((s) => s.stream === "messages");
  const imessageMessages = imessage.streams.find((s) => s.stream === "messages");
  assert.equal(slackMessages?.loadedCount, 3, "Slack messages = Slack's loaded rows only");
  assert.equal(imessageMessages?.loadedCount, 1, "iMessage messages = iMessage's loaded rows only");

  // channels is Slack-only: 2 under Slack, absent under iMessage.
  assert.equal(slack.streams.find((s) => s.stream === "channels")?.loadedCount, 2);
  assert.equal(
    imessage.streams.find((s) => s.stream === "channels"),
    undefined
  );
});

test("source loadedTotal is the sum of its visible streams' loaded counts (same KIND, not a lifetime total)", () => {
  const feed = [entry("conn_slack", "messages"), entry("conn_slack", "messages"), entry("conn_slack", "channels")];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  assert.equal(groups[0]?.loadedTotal, 3);
});

test("0-in-window stream is hidden (no dead-end) UNLESS it is an active filter", () => {
  // Only channels has loaded rows; messages has zero in the window.
  const feed = [entry("conn_slack", "channels")];

  const hidden = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  // messages (0 in window, not selected) must NOT appear — never a "0" dead-end.
  assert.equal(
    hidden[0]?.streams.find((s) => s.stream === "messages"),
    undefined
  );
  assert.equal(hidden[0]?.streams.length, 1);

  // But a SELECTED messages stays visible even at 0 — an active filter is never hidden.
  const withSelected = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: ["messages"],
    excludeStreams: [],
  });
  const sel = withSelected[0]?.streams.find((s) => s.stream === "messages");
  assert.ok(sel, "a selected stream with 0 in-window rows is kept (no dropped filter)");
  assert.equal(sel?.loadedCount, 0);
  assert.equal(sel?.selected, true);

  // Likewise an EXCLUDED stream at 0 stays visible.
  const withExcluded = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: ["messages"],
  });
  const ex = withExcluded[0]?.streams.find((s) => s.stream === "messages");
  assert.ok(ex);
  assert.equal(ex?.excluded, true);
});

test("a source with no visible streams is dropped entirely (no empty group)", () => {
  // iMessage owns messages/attachments but the loaded window has neither.
  const feed = [entry("conn_slack", "channels")];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK, IMESSAGE],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  assert.equal(
    groups.find((g) => g.connectionId === "conn_imessage"),
    undefined
  );
});

test("when connections are selected, the rail scopes to those sources only", () => {
  const feed = [entry("conn_slack", "messages"), entry("conn_imessage", "messages")];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK, IMESSAGE],
    passes: ALL,
    selectedConnectionIds: ["conn_slack"],
    selectedStreams: [],
    excludeStreams: [],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.connectionId, "conn_slack");
});

test("the client predicate is honored: counts only loaded rows that pass (count==reachability)", () => {
  const feed = [entry("conn_slack", "messages"), entry("conn_slack", "messages"), entry("conn_slack", "messages")];
  // Predicate drops every other row → 2 of 3 pass.
  let i = 0;
  const everyOther = () => {
    const keep = i % 2 === 0;
    i += 1;
    return keep;
  };
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: everyOther,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  assert.equal(
    groups[0]?.streams.find((s) => s.stream === "messages")?.loadedCount,
    2,
    "the count reflects only rows the predicate keeps — the number a click reaches"
  );
});

test("rows with a null connectionId never contribute to a per-source count", () => {
  // A search-hit row may carry no concrete connection binding.
  const feed: ExplorerFeedEntry[] = [
    { ...entry("conn_slack", "messages") },
    { ...entry("conn_slack", "messages"), connectionId: null },
  ];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  // Only the row with a concrete connectionId counts (1, not 2).
  assert.equal(groups[0]?.streams.find((s) => s.stream === "messages")?.loadedCount, 1);
});

test("active filters pin to the top of a source group; the rest rank by loaded count", () => {
  const feed = [
    entry("conn_slack", "channels"),
    entry("conn_slack", "channels"),
    entry("conn_slack", "channels"),
    entry("conn_slack", "messages"),
  ];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: ["messages"], // selected, but fewer loaded rows
    excludeStreams: [],
  });
  // Selected `messages` pins first despite channels having more rows.
  assert.equal(groups[0]?.streams[0]?.stream, "messages");
  assert.equal(groups[0]?.streams[0]?.selected, true);
  assert.equal(groups[0]?.streams[1]?.stream, "channels");
});

test("totalVisibleStreamFacets sums the rendered stream rows across groups", () => {
  const feed = [entry("conn_slack", "messages"), entry("conn_slack", "channels"), entry("conn_imessage", "messages")];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK, IMESSAGE],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  // Slack: messages + channels (2); iMessage: messages (1) → 3 total.
  assert.equal(totalVisibleStreamFacets(groups), 3);
});

test("filterSourceGroups matches source name (keep whole group) or stream names (keep matching streams)", () => {
  const feed = [
    entry("conn_slack", "messages"),
    entry("conn_slack", "channels"),
    entry("conn_imessage", "messages"),
    entry("conn_imessage", "attachments"),
  ];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK, IMESSAGE],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });

  // Matching the SOURCE name keeps the whole group with all its streams.
  const bySource = filterSourceGroups(groups, "imessage");
  assert.equal(bySource.length, 1);
  assert.equal(bySource[0]?.connectionId, "conn_imessage");
  assert.equal(bySource[0]?.streams.length, 2);

  // Matching a STREAM name keeps only the groups/streams that match.
  const byStream = filterSourceGroups(groups, "channels");
  assert.equal(byStream.length, 1);
  assert.equal(byStream[0]?.connectionId, "conn_slack");
  assert.deepEqual(
    byStream[0]?.streams.map((s) => s.stream),
    ["channels"]
  );

  // Empty query is a no-op (all groups).
  assert.equal(filterSourceGroups(groups, "  ").length, groups.length);
});

test("filterSourceGroups recomputes the group total over the surviving streams", () => {
  const feed = [entry("conn_slack", "messages"), entry("conn_slack", "messages"), entry("conn_slack", "channels")];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [SLACK],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  // Filtering to just `channels` makes the source total 1 (not the full 3).
  const filtered = filterSourceGroups(groups, "channels");
  assert.equal(filtered[0]?.loadedTotal, 1);
});
