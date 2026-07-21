// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Saved-view tabs (R5) honesty + correctness pins. The design contract
 * (08-saved-views-design.md): user-authored named queries, NOT guessed presets;
 * localStorage-only; active-tab matching ignores pagination/peek/param-order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeSavedView,
  addSavedView,
  canonicalViewIdentity,
  canSaveCurrentView,
  isAllView,
  parseSavedViews,
  removeSavedView,
  type SavedView,
  sameView,
} from "./explore-saved-views.ts";

const view = (id: string, name: string, href: string): SavedView => ({ id, name, href });

test("canonicalViewIdentity ignores volatile params (peek/cursor/anchor) and param order", () => {
  const a = "/explore?q=deploy&connection=con_1&peek=p1&cursor=c1&anchor=a1";
  const b = "/explore?connection=con_1&q=deploy";
  assert.equal(canonicalViewIdentity(a), canonicalViewIdentity(b));
  assert.ok(sameView(a, b));
});

test("canonicalViewIdentity treats repeated params order-independently", () => {
  const a = "/explore?connection=con_b&connection=con_a";
  const b = "/explore?connection=con_a&connection=con_b";
  assert.equal(canonicalViewIdentity(a), canonicalViewIdentity(b));
});

test("a bare path, and a path with only volatile params, are the All view", () => {
  assert.ok(isAllView("/explore"));
  assert.ok(isAllView("/explore?peek=p1&cursor=c1"));
  assert.equal(canonicalViewIdentity("/explore?peek=p1"), "");
  assert.ok(!isAllView("/explore?q=deploy"));
});

// U1 — canonical "All" identity lock (THE-LENS Gate 1 / honesty-copy/design.md §2, U1).
// The BARE `/explore` (no querystring) IS the single canonical identity of "All".
// Adding a cosmetic default param (e.g. `?lens=recent`) would create a rival representation
// and break isAllView unless that param were also made volatile — both net-negative. This
// test pins the invariant so future changes can't inject default params.
test("U1: the bare /explore is the canonical 'All' identity (empty, isAllView)", () => {
  assert.equal(canonicalViewIdentity("/explore"), "");
  assert.ok(isAllView("/explore"));
  // A serialized default param would NOT be the canonical identity — guards against regression.
  assert.notEqual(canonicalViewIdentity("/explore?lens=recent"), "");
  assert.ok(!isAllView("/explore?lens=recent"));
});

test("parseSavedViews drops malformed entries, never throws", () => {
  assert.deepEqual(parseSavedViews(null), []);
  assert.deepEqual(parseSavedViews("not json"), []);
  assert.deepEqual(parseSavedViews(JSON.stringify({ not: "an array" })), []);
  const raw = JSON.stringify([
    { id: "1", name: "Finance", href: "/explore?q=x" },
    { id: "2", name: "", href: "/explore?q=y" }, // empty name → dropped
    { id: "3", href: "/explore?q=z" }, // missing name → dropped
    { name: "no id", href: "/x" }, // missing id → dropped
    "garbage",
  ]);
  assert.deepEqual(parseSavedViews(raw), [{ id: "1", name: "Finance", href: "/explore?q=x" }]);
});

test("addSavedView never saves the All (no-filter) view as a tab", () => {
  // This is the honesty guard: "All" is the built-in tab, not a saved one, and a
  // bare/volatile-only href must never become a user tab.
  const before: SavedView[] = [];
  assert.deepEqual(addSavedView(before, view("a", "All-ish", "/explore")), []);
  assert.deepEqual(addSavedView(before, view("a", "All-ish", "/explore?peek=p1")), []);
});

test("addSavedView is idempotent on view identity (no duplicate tabs for the same filter)", () => {
  const v1 = view("1", "Slack", "/explore?connection=con_slack");
  const dup = view("2", "Slack again", "/explore?connection=con_slack&peek=p9");
  const once = addSavedView([], v1);
  assert.equal(once.length, 1);
  assert.deepEqual(addSavedView(once, dup), once); // same identity → unchanged
});

test("addSavedView appends a genuinely distinct view; removeSavedView deletes by id", () => {
  let views = addSavedView([], view("1", "Slack", "/explore?connection=con_slack"));
  views = addSavedView(views, view("2", "Notion docs", "/explore?stream=documents&connection=con_notion"));
  assert.equal(views.length, 2);
  views = removeSavedView(views, "1");
  assert.deepEqual(
    views.map((v) => v.id),
    ["2"]
  );
});

test("activeSavedView matches the saved view regardless of pagination/peek; null for All", () => {
  const views = [view("1", "Slack", "/explore?connection=con_slack"), view("2", "Deploys", "/explore?q=deploy")];
  // current href carries peek + cursor — still the same view
  assert.equal(activeSavedView(views, "/explore?connection=con_slack&peek=p1&cursor=c2")?.id, "1");
  assert.equal(activeSavedView(views, "/explore?q=deploy")?.id, "2");
  assert.equal(activeSavedView(views, "/explore"), null); // All
  assert.equal(activeSavedView(views, "/explore?q=unsaved"), null); // unsaved filter
});

test("canSaveCurrentView: offered only for a NON-All filter not already saved", () => {
  const views = [view("1", "Slack", "/explore?connection=con_slack")];
  assert.equal(canSaveCurrentView(views, "/explore"), false); // All → no
  assert.equal(canSaveCurrentView(views, "/explore?connection=con_slack"), false); // already saved
  assert.equal(canSaveCurrentView(views, "/explore?q=newfilter"), true); // new filter → yes
});
