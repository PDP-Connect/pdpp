// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeRangeKey,
  buildCompleteStreamHref,
  buildRecordDetailHref,
  resolveRowKeyAction,
  sinceForRange,
  toggleIdSelection,
} from "./explore-control-state.ts";

const NOW_MS = Date.parse("2026-06-18T15:00:00Z");

test("activeRangeKey marks only the matching shortcut active", () => {
  assert.equal(activeRangeKey({ since: "", until: "" }, NOW_MS), "all");
  assert.equal(activeRangeKey({ since: sinceForRange("today", NOW_MS), until: "" }, NOW_MS), "today");
  assert.equal(activeRangeKey({ since: sinceForRange("7d", NOW_MS), until: "" }, NOW_MS), "7d");
  assert.equal(activeRangeKey({ since: sinceForRange("30d", NOW_MS), until: "" }, NOW_MS), "30d");
});

test("activeRangeKey treats explicit until and non-shortcut dates as custom", () => {
  assert.equal(activeRangeKey({ since: "2026-06-01", until: "2026-06-07" }, NOW_MS), "custom");
  assert.equal(activeRangeKey({ since: "2026-06-02", until: "" }, NOW_MS), "custom");
});

test("toggleIdSelection accumulates rapid multi-select state without collapsing to the first click", () => {
  const afterOne = toggleIdSelection([], "conn-a");
  const afterTwo = toggleIdSelection(afterOne, "conn-b");
  const afterThree = toggleIdSelection(afterTwo, "conn-a");

  assert.deepEqual(afterOne, ["conn-a"]);
  assert.deepEqual(afterTwo, ["conn-a", "conn-b"]);
  assert.deepEqual(afterThree, ["conn-b"]);
});

test("buildCompleteStreamHref preserves source scope and exact filters for the full-set route", () => {
  const href = buildCompleteStreamHref(
    "/sources",
    {
      connectionId: "conn_gmail_personal",
      connectorId: "gmail",
      stream: "messages/threads",
    },
    {
      exactFilters: [
        { key: "merchant", value: "Blue Bottle" },
        { key: "account_id", value: "acct/42" },
      ],
    }
  );

  const url = new URL(href, "https://console.test");
  assert.equal(url.pathname, "/sources/conn_gmail_personal/messages%2Fthreads");
  assert.equal(url.searchParams.get("filter[merchant]"), "Blue Bottle");
  assert.equal(url.searchParams.get("filter[account_id]"), "acct/42");
});

test("buildCompleteStreamHref falls back to connector id and does not invent unsupported filters", () => {
  const href = buildCompleteStreamHref(
    "/sources",
    {
      connectionId: null,
      connectorId: "github",
      stream: "issues",
    },
    {
      exactFilters: [
        { key: "", value: "ignored" },
        { key: "state", value: "" },
      ],
    }
  );

  assert.equal(href, "/sources/github/issues");
});

test("buildCompleteStreamHref preserves server-supported sort order", () => {
  const subject = {
    connectionId: "conn_gmail_personal",
    connectorId: "gmail",
    stream: "messages",
  };

  assert.equal(
    buildCompleteStreamHref("/sources", subject, { order: "oldest" }),
    "/sources/conn_gmail_personal/messages?order=asc"
  );
  assert.equal(
    buildCompleteStreamHref("/sources", subject, { order: "newest" }),
    "/sources/conn_gmail_personal/messages?order=desc"
  );
});

test("buildRecordDetailHref builds the record-detail route from clean path segments (no sort query)", () => {
  const href = buildRecordDetailHref("/sources", {
    connectionId: "cin_bc1efca69a1c386d610f0924",
    connectorId: "usaa",
    stream: "transactions",
    recordId: "d495b98f5bfe6ce1ae10c465aeb607b5",
  });
  assert.equal(href, "/sources/cin_bc1efca69a1c386d610f0924/transactions/d495b98f5bfe6ce1ae10c465aeb607b5");
});

test("buildRecordDetailHref reproduce-the-bug: no query string, record key is the FINAL path segment", () => {
  // Regression for the malformed `transactions?order=desc/<recordId>` href that
  // appended the record key to the stream href: the ?order=desc swallowed the
  // key, the path was only [connector]/[stream], and the tap landed on the whole
  // stream LIST instead of the record. The detail href must carry no `?` and end
  // with the encoded record key as its last segment.
  const recordId = "rec with/slash & spaces";
  const href = buildRecordDetailHref("/sources", {
    connectionId: null,
    connectorId: "gmail",
    stream: "messages",
    recordId,
  });
  assert.ok(!href.includes("?"), `record detail href must not contain a query string: ${href}`);
  assert.ok(!href.includes("order="), `record detail href must not carry a sort order: ${href}`);
  const segments = href.split("/");
  assert.equal(segments.at(-1), encodeURIComponent(recordId), "record key must be the final, encoded path segment");
  assert.equal(href, `/sources/gmail/messages/${encodeURIComponent(recordId)}`);
});

test("buildRecordDetailHref falls back to connectorId when connection identity is unknown (search rows)", () => {
  const href = buildRecordDetailHref("/sources", {
    connectionId: null,
    connectorId: "github",
    stream: "issues",
    recordId: "42",
  });
  assert.equal(href, "/sources/github/issues/42");
});

// ─── Slice 3: the keyboard row-action contract (design.md §6, feedback #12) ──

test("resolveRowKeyAction: arrows move the selection and prevent default", () => {
  assert.deepEqual(resolveRowKeyAction({ key: "ArrowDown" }), { action: "move-down", preventDefault: true });
  assert.deepEqual(resolveRowKeyAction({ key: "ArrowUp" }), { action: "move-up", preventDefault: true });
});

test("resolveRowKeyAction: plain Enter opens the in-place PEEK (not the full route)", () => {
  assert.deepEqual(resolveRowKeyAction({ key: "Enter" }), { action: "peek", preventDefault: true });
});

test("resolveRowKeyAction: Cmd/Ctrl-Enter ESCALATES to the full record route (distinct from peek, #12)", () => {
  // The modifier is the ONLY thing that distinguishes peek from open-full — the
  // same peek-vs-open distinction the desktop row click vs Open button makes.
  assert.deepEqual(resolveRowKeyAction({ key: "Enter", metaKey: true }), {
    action: "open-full",
    preventDefault: true,
  });
  assert.deepEqual(resolveRowKeyAction({ key: "Enter", ctrlKey: true }), {
    action: "open-full",
    preventDefault: true,
  });
  // Distinctness guard: plain Enter and modified Enter must NOT resolve to the
  // same action (otherwise the keyboard Open would be a useless duplicate).
  assert.notEqual(
    resolveRowKeyAction({ key: "Enter" }).action,
    resolveRowKeyAction({ key: "Enter", metaKey: true }).action
  );
});

test("resolveRowKeyAction: Escape clears the selection/peek", () => {
  assert.deepEqual(resolveRowKeyAction({ key: "Escape" }), { action: "clear", preventDefault: true });
});

test("resolveRowKeyAction: an unrelated key is a no-op that does NOT preventDefault", () => {
  // Typing characters / Tab / etc. must not be swallowed by the row handler.
  for (const key of ["a", "Tab", " ", "Home", "PageDown"]) {
    assert.deepEqual(resolveRowKeyAction({ key }), { action: "none", preventDefault: false }, `key ${key}`);
  }
});
