/**
 * In-page navigation loading-state logic — the pending/affordance contract.
 *
 * docs/research/explore-loading-states-design-2026-06-20.md: a soft same-route
 * `router.push` does NOT fire `loading.tsx`, so the canvas wraps the push in
 * `useTransition` and drives its own affordances off `isPending` + which action
 * started the transition (`PendingKind`). These tests assert the pure
 * derivations directly (no React), mirroring the `explore-navigation.ts`
 * precedent: the loading contract is pinned against plain functions, not a
 * rendered `"use client"` component.
 *
 * The load-bearing invariants:
 *   - The Load-more inline spinner shows ONLY for a Load-more push (`"loadmore"`),
 *     never for an unrelated filter/sort/peek navigation.
 *   - A stale `pendingKind` can NEVER leak a spinner once navigation completes
 *     (`isPending` false collapses the effective kind to null).
 *   - Any in-flight navigation disables Load-more and marks the feed busy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  effectivePendingKind,
  feedAriaBusy,
  isLoadMorePending,
  loadMoreDisabled,
  loadMoreLabel,
  loadMoreRestingLabel,
} from "./explore-pending.ts";

// ─── effectivePendingKind: only meaningful while a transition is in flight ────

test("effectivePendingKind returns the recorded kind only while pending", () => {
  assert.equal(effectivePendingKind(true, "loadmore"), "loadmore");
  assert.equal(effectivePendingKind(true, "navigation"), "navigation");
});

test("effectivePendingKind collapses to null when NOT pending (no stale leak)", () => {
  // The transition has completed (navigation arrived); the last recorded kind
  // must NOT linger and keep an affordance "loading".
  assert.equal(effectivePendingKind(false, "loadmore"), null);
  assert.equal(effectivePendingKind(false, "navigation"), null);
  assert.equal(effectivePendingKind(false, null), null);
});

// ─── isLoadMorePending: the spinner shows ONLY for a Load-more push ───────────

test("isLoadMorePending is true ONLY for a pending Load-more push", () => {
  assert.equal(isLoadMorePending(true, "loadmore"), true, "Load-more push in flight → spin");
});

test("isLoadMorePending is false for a pending NON-Load-more navigation", () => {
  // A filter/sort/range/peek/search push is in flight, but the Load-more button
  // must NOT spin — it would falsely claim "more is loading".
  assert.equal(isLoadMorePending(true, "navigation"), false);
});

test("isLoadMorePending is false once navigation completes (stale kind)", () => {
  assert.equal(isLoadMorePending(false, "loadmore"), false, "no spin after a completed Load-more");
});

// ─── loadMoreDisabled: any in-flight navigation disables Load-more ────────────

test("loadMoreDisabled tracks isPending for ANY navigation kind", () => {
  assert.equal(loadMoreDisabled(true), true, "any pending nav disables Load-more (no double-push race)");
  assert.equal(loadMoreDisabled(false), false, "re-enabled when the transition completes");
});

// ─── loadMoreLabel / loadMoreRestingLabel: busy label only for Load-more ──────

test("loadMoreRestingLabel preserves the existing per-descriptor copy", () => {
  assert.equal(loadMoreRestingLabel("complete_chronological"), "Load more →");
  assert.equal(loadMoreRestingLabel("keyword_pageable"), "Load more results →");
  assert.equal(loadMoreRestingLabel("relevance_bounded"), "Load more results →");
});

test("loadMoreLabel swaps to 'Loading…' ONLY for a pending Load-more push", () => {
  const resting = loadMoreRestingLabel("complete_chronological");
  assert.equal(loadMoreLabel(resting, true, "loadmore"), "Loading…", "Load-more in flight → busy label");
  assert.equal(loadMoreLabel(resting, true, "navigation"), resting, "unrelated nav keeps the resting label");
  assert.equal(loadMoreLabel(resting, false, "loadmore"), resting, "completed nav restores the resting label");
});

// ─── Feed busy affordance ─────────────────────────────────────────────────────

test("feedAriaBusy is 'true' while pending and undefined otherwise (attribute absent)", () => {
  assert.equal(feedAriaBusy(true), "true");
  assert.equal(feedAriaBusy(false), undefined);
});

// ─── Canvas wiring (source invariant) ─────────────────────────────────────────
//
// explore-canvas.tsx is a `"use client"` component that is hard to import in
// node:test, so this asserts the integration the pure helpers above cannot
// reach: the soft same-route push is wrapped in `useTransition` (otherwise no
// loading.tsx fires AND no in-page feedback), the Load-more push is tagged
// "loadmore", and the busy affordances are wired through the pending helpers.

const CANVAS_SRC = readFileSync(fileURLToPath(new URL("./explore-canvas.tsx", import.meta.url)), "utf8");

/** Every navigation push runs inside startTransition (the soft-push gap fix). */
const START_TRANSITION_PUSH_RE = /startTransition\(\(\)\s*=>\s*router\.push\(/;
/** Each Load-more navigate() call is tagged "loadmore" so only it spins. */
const LOADMORE_TAG_RE = /,\s*"loadmore"\)/g;
/** The progress wrapper is a polite live region (role + aria-live, either order). */
const PROGRESS_LIVE_REGION_RE = /role="status"[\s\S]*?aria-live="polite"|aria-live="polite"[\s\S]*?role="status"/;

test("canvas wraps router.push in startTransition (soft-push gap fix)", () => {
  assert.match(
    CANVAS_SRC,
    START_TRANSITION_PUSH_RE,
    "every navigation push must run inside startTransition so isPending drives the loading affordances"
  );
  assert.ok(
    CANVAS_SRC.includes("useTransition()"),
    "the canvas must use useTransition for in-page navigation pending state"
  );
});

test("canvas tags the Load-more push as 'loadmore' so only it spins", () => {
  // The onLoadMore handler passes "loadmore" as the navigate kind for both the
  // chronological (appendCursor) and lexical (cursor) branches.
  const loadmoreTags = CANVAS_SRC.match(LOADMORE_TAG_RE) ?? [];
  assert.ok(
    loadmoreTags.length >= 2,
    `expected both Load-more navigate() calls tagged "loadmore", got ${loadmoreTags.length}`
  );
});

test("canvas renders the progress bar, feed busy, and Load-more busy affordances", () => {
  // W3: the top bar is wired to isPending but SCOPED to non-Load-more pushes
  // (see the dedicated scope test below) — Load-more uses local insertion-point
  // feedback because a top-y:0 bar is off-screen for a scrolled-down user.
  assert.ok(
    CANVAS_SRC.includes('<RouteProgress active={isPending && pendingKind !== "loadmore"} />'),
    "top route-progress bar wired to isPending, scoped to non-Load-more navigations"
  );
  assert.ok(CANVAS_SRC.includes("feedAriaBusy(isPending)"), "feed aria-busy wired");
  assert.ok(CANVAS_SRC.includes("loadMoreLabel("), "Load-more busy label wired");
  assert.ok(CANVAS_SRC.includes("loadMoreDisabled(isPending)"), "Load-more disabled-while-pending wired");
  assert.ok(CANVAS_SRC.includes("useLinkStatus"), "row Link inline pending (useLinkStatus) wired");
});

test("the feed region is NOT dimmed/disabled while pending (records stay interactive)", () => {
  // useTransition keeps the current UI live, and the loading signal lives in the
  // progress bar + Load-more control — so the feed must NOT be dimmed or
  // pointer-events-blocked while loading. The owner can keep clicking already-
  // rendered records while more load.
  assert.ok(
    !CANVAS_SRC.includes("feedBusyClassName"),
    "the feed must not apply a busy/dim class — already-rendered records stay fully interactive"
  );
  assert.ok(
    CANVAS_SRC.includes('className="rr-x-main"'),
    "the feed uses the plain rr-x-main class (no pending modifier)"
  );
});

test("canvas progress + spinner indicators are aria-hidden (decorative), with an accessible label", () => {
  // The moving bar/spinner are decorative; the polite live region + button label
  // carry the accessible signal.
  assert.match(CANVAS_SRC, PROGRESS_LIVE_REGION_RE);
  assert.ok(CANVAS_SRC.includes('<span className="sr-only">Loading…</span>'), "sr-only Loading label present");
  assert.ok(CANVAS_SRC.includes('aria-hidden className="rr-x-progress__bar"'), "progress bar is aria-hidden");
});

// ─── W3: loading feedback at the point of attention (scrolled-down Load-more) ──
//
// THE BUG (Tim re-flagged, reproduced live): the only Load-more "animation" was
// `rr-x-progress` — a 2px bar pinned to the TOP of the canvas at y:0. But the
// scroll container is `.rr-content` (overflow-y:auto). So a scrolled-down owner
// who clicks Load-more sees NO feedback: the bar is off-screen above them
// (confirmed: at scrollTop 694 the y:0 bar is outside the visible band).
//
// THE FIX (RL4): scope the top bar to NON-Load-more navigations and put the
// Load-more pending feedback at the POINT OF ATTENTION — the foot of the loaded
// feed where the owner clicked: an inline button spinner + reserved-height
// skeleton rows at the insertion point, plus a polite live announcement. These
// are non-destructive (additive siblings; the loaded rows stay mounted).
//
// Because the canvas is a `"use client"` component that node:test can't render,
// these are SOURCE-STRUCTURE assertions over explore-canvas.tsx (the existing
// canvas-wiring pattern in this file). They prove WHERE each indicator mounts
// relative to the top bar vs the button — the positional contract the live
// scrolled-viewport bug requires — without a DOM.

/** The top bar must be gated OFF for a Load-more push (off-screen anti-pattern). */
const ROUTEPROGRESS_SCOPED_RE = /<RouteProgress active=\{isPending && pendingKind !== "loadmore"\} \/>/;
/** The insertion-point skeleton renders only for a Load-more push. */
const MAIN_SKELETON_GUARD_RE =
  /loadMoreCursor && isLoadMorePending\(isPending, pendingKind\) \? \(\s*<LoadMoreSkeleton label="Loading more records…" \/>/;
/** The loaded rows must NEVER be swapped out for the skeleton while pending. */
const FEEDDAYS_NOT_SWAPPED_RE = /isPending\s*\?[^;]*<FeedDays/;
/** The skeleton carries a sibling polite live region announcing the {label}. */
const SKELETON_LIVE_REGION_RE = /<span aria-live="polite" className="sr-only" role="status">\s*\{label\}/;

test("W3: top progress bar is SCOPED OFF for Load-more (the off-screen anti-pattern fix)", () => {
  // The top bar lives at canvas y:0; for a scrolled-down Load-more it is above
  // the viewport. It must NOT be the Load-more signal — gate it to non-loadmore.
  assert.match(
    CANVAS_SRC,
    ROUTEPROGRESS_SCOPED_RE,
    "RouteProgress must be active only when pendingKind !== 'loadmore' (top bar is off-screen for a scrolled Load-more)"
  );
  // The string `active={isPending}` (unscoped, the old buggy wiring) must be gone.
  assert.ok(
    !CANVAS_SRC.includes("<RouteProgress active={isPending} />"),
    "the unscoped (always-fires-on-Load-more) RouteProgress wiring must be removed"
  );
});

test("W3: the Load-more pending indicator mounts at the BUTTON / insertion point, not the page top", () => {
  // Proof of placement-by-render-position. The off-screen bug is positional: the
  // top bar lives in the TOP-LEVEL canvas render (ExploreCanvas), at y:0; the
  // Load-more feedback must live at the FOOT of the feed inside FeedBody (the
  // insertion point), where the scrolled-down owner's attention and click are.
  //
  // Render-tree position is captured by COMPONENT membership, not raw source
  // order (component functions are defined out of render order): we slice the
  // FeedBody function body and prove the skeleton + button-spinner are rendered
  // there (the foot of the feed), AFTER the loaded rows (FeedDays), immediately
  // ABOVE the Load-more button — and that the top bar is NOT a FeedBody affordance.
  const feedBodyStart = CANVAS_SRC.indexOf("function FeedBody(");
  const feedBodyEnd = CANVAS_SRC.indexOf("// ─── ExploreCanvas", feedBodyStart);
  assert.ok(feedBodyStart >= 0 && feedBodyEnd > feedBodyStart, "FeedBody component bounds located");
  const feedBodySrc = CANVAS_SRC.slice(feedBodyStart, feedBodyEnd);

  const feedDaysIdx = feedBodySrc.indexOf("<FeedDays");
  const skeletonIdx = feedBodySrc.indexOf('<LoadMoreSkeleton label="Loading more records…" />');
  const spinnerIdx = feedBodySrc.indexOf('className="rr-x-loadmore__spinner"');
  const buttonIdx = feedBodySrc.indexOf('className="rr-x-loadmore"');

  assert.ok(feedDaysIdx >= 0, "FeedBody renders the loaded rows (FeedDays)");
  assert.ok(skeletonIdx >= 0, "FeedBody renders the insertion-point skeleton");
  assert.ok(spinnerIdx >= 0, "FeedBody renders the Load-more button spinner");
  assert.ok(buttonIdx >= 0, "FeedBody renders the Load-more button");

  // The top bar is NOT one of FeedBody's affordances — it is a page-top signal in
  // the parent canvas only, so it can never be the scrolled-down Load-more cue.
  assert.ok(
    !feedBodySrc.includes("<RouteProgress"),
    "the top progress bar must NOT live in the feed body — Load-more feedback is local"
  );

  // Insertion-point ordering: loaded rows → skeleton → button. The skeleton is
  // appended BELOW the loaded rows and sits immediately ABOVE the trigger, so the
  // pending feedback lands exactly where the next page will appear and where the
  // owner clicked (inside the scroll viewport).
  assert.ok(skeletonIdx > feedDaysIdx, "skeleton is appended BELOW the loaded rows (at the insertion point)");
  assert.ok(buttonIdx > skeletonIdx, "skeleton sits immediately ABOVE the Load-more button");
  // The spinner is a CHILD of the Load-more button (rendered after the button's
  // opening className, before that button closes) — co-located at the trigger.
  const buttonCloseIdx = feedBodySrc.indexOf("</button>", buttonIdx);
  assert.ok(buttonCloseIdx > buttonIdx, "Load-more button has a closing tag");
  assert.ok(spinnerIdx > buttonIdx && spinnerIdx < buttonCloseIdx, "the spinner is a child of the Load-more button");
});

test("W3: skeleton renders ONLY for a Load-more push and is purely additive (loaded rows kept)", () => {
  // The skeleton is conditional on isLoadMorePending — an unrelated filter/sort
  // navigation does NOT paint phantom rows.
  assert.match(
    CANVAS_SRC,
    MAIN_SKELETON_GUARD_RE,
    "the insertion-point skeleton must be guarded by isLoadMorePending (not any-navigation)"
  );
  // RL4 non-destructive: the loaded feed (FeedDays) is rendered UNCONDITIONALLY,
  // independent of pending state — the skeleton never replaces/removes it. The
  // skeleton is a SIBLING appended after FeedDays, so the loaded rows stay in the
  // DOM during pending.
  const feedDaysIdx = CANVAS_SRC.indexOf("<FeedDays");
  const skeletonIdx = CANVAS_SRC.indexOf("<LoadMoreSkeleton");
  assert.ok(feedDaysIdx >= 0, "FeedDays (the loaded rows) is rendered");
  assert.ok(
    skeletonIdx > feedDaysIdx,
    "the skeleton is a sibling appended AFTER the loaded rows, never replacing them"
  );
  // FeedDays must NOT be wrapped in a pending conditional (no `isPending ? ... : <FeedDays`).
  assert.ok(
    !FEEDDAYS_NOT_SWAPPED_RE.test(CANVAS_SRC),
    "the loaded rows must never be swapped out for the skeleton while pending"
  );
});

test("W3: the skeleton is decorative (aria-hidden) with a sibling polite live announcement", () => {
  // The shimmer is decorative; the announcement is a sibling role=status live region
  // inside the LoadMoreSkeleton component (so screen readers hear "Loading more
  // records…" without the placeholder rows being announced row-by-row).
  assert.ok(
    CANVAS_SRC.includes('<div aria-hidden className="rr-x-loadmore-skeleton">'),
    "the skeleton placeholder block is aria-hidden (decorative)"
  );
  assert.ok(
    SKELETON_LIVE_REGION_RE.test(CANVAS_SRC),
    "the skeleton carries a sibling polite live region announcing the {label}"
  );
  // It contains no focusable elements → it cannot steal focus from the button.
  const compStart = CANVAS_SRC.indexOf("function LoadMoreSkeleton");
  const compEnd = CANVAS_SRC.indexOf("function FeedStatusLine");
  const compSrc = CANVAS_SRC.slice(compStart, compEnd);
  assert.ok(compStart >= 0 && compEnd > compStart, "LoadMoreSkeleton component bounds located");
  assert.ok(
    !(compSrc.includes("<button") || compSrc.includes("<a ") || compSrc.includes("tabIndex")),
    "the skeleton must contain no focusable element (RL4: must not steal focus)"
  );
});

test("W3: the Upcoming projection gets the SAME insertion-point skeleton (mobile thumb point)", () => {
  assert.ok(
    CANVAS_SRC.includes('<LoadMoreSkeleton label="Loading more upcoming records…" />'),
    "the Upcoming Load-more carries its own insertion-point skeleton + announcement"
  );
});

// ─── W3: reduced-motion gating (no unexpected keyframe motion) ────────────────
//
// The skeleton CSS lives in the brand package. Base rules must be a STATIC,
// visible placeholder; every keyframe (the shimmer sweep, the fade-in) must be
// gated behind @media (prefers-reduced-motion: no-preference) and reuse an
// EXISTING keyframe (rr-x-row-pending-sweep) — no new token, no new keyframe.

const BRAND_CSS_SRC = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/pdpp-brand-react/src/components.css", import.meta.url)),
  "utf8"
);

test("W3: skeleton shimmer keyframe is gated behind prefers-reduced-motion (no unexpected motion)", () => {
  // Find the skeleton block.
  const skelBlock = BRAND_CSS_SRC.indexOf(".rr-x-loadmore-skeleton {");
  assert.ok(skelBlock >= 0, ".rr-x-loadmore-skeleton CSS present");

  // The bar's `animation:` declaration must appear ONLY inside a
  // prefers-reduced-motion: no-preference block — never as a base rule.
  const reducedMotionBlocks = BRAND_CSS_SRC.match(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g);
  assert.ok(reducedMotionBlocks && reducedMotionBlocks.length > 0, "reduced-motion no-preference blocks present");
  const motionGuarded = reducedMotionBlocks.some(
    (block) => block.includes(".rr-x-skel-bar") && block.includes("rr-x-row-pending-sweep")
  );
  assert.ok(
    motionGuarded,
    "the skeleton shimmer (rr-x-row-pending-sweep) must live inside a prefers-reduced-motion: no-preference block"
  );

  // The base `.rr-x-skel-bar` rule must NOT carry an `animation:` (static fallback).
  const baseSkelBar = BRAND_CSS_SRC.slice(
    BRAND_CSS_SRC.indexOf(".rr-x-skel-bar {"),
    BRAND_CSS_SRC.indexOf(".rr-x-skel-bar--attr")
  );
  assert.ok(baseSkelBar.length > 0, ".rr-x-skel-bar base rule located");
  assert.ok(
    !baseSkelBar.includes("animation"),
    "the base .rr-x-skel-bar rule must be static (no animation outside reduced-motion gate)"
  );

  // No NEW keyframe was introduced for the skeleton — it reuses the existing sweep.
  assert.ok(
    !BRAND_CSS_SRC.includes("@keyframes rr-x-skel"),
    "the skeleton must reuse the existing rr-x-row-pending-sweep keyframe, not introduce a new one"
  );
});
