/**
 * Source-text invariants for the records-list view.
 *
 * The view file is a JSX React component, so it cannot be imported as a
 * module in Node's test runner without a full JSX/React resolver. We verify
 * the critical structural properties by reading the source file directly.
 * Behavioural tests for the pure formatters live in connection-evidence.test.ts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIEW_FILE = `${HERE}records-list-view.tsx`;
const NEEDS_ATTENTION_LABEL_RE = /"Needs attention"/;
const RUNNING_LABEL_RE = /"Running"/;
const STALE_LABEL_RE = /"Stale"/;
const NO_ACTIVE_RUNS_RETURN_RE = /return "No active runs"/;
const FAILING_RETURN_RE = /return "Failing"/;
const ALL_FRESH_RETURN_RE = /return "All fresh"/;
const STALE_OVER_SEVEN_DAYS_RETURN_RE = /return "Stale >7d"/;
const NO_SCHEDULER_RUN_RETURN_RE = /return "No scheduler run"/;
const IDLE_RETURN_RE = /return "Idle"/;
const NEEDS_ATTENTION_STATE_RE = /state === "needs_attention"/;
const BLOCKED_STATE_RE = /state === "blocked"/;
const DEGRADED_STATE_RE = /state === "degraded"/;
const FAILED_RUN_FALLBACK_RE = /!state && o\.lastRun\?\.status === "failed"/;
const STALE_FRESHNESS_AXIS_RE = /axes\.freshness === "stale"/;
const NEEDS_ATTENTION_COUNT_RE = /state === "blocked" \|\| state === "needs_attention"/;
const SYNCING_BADGE_RE = /connectionHealth\?\.badges\.syncing/;

test("vital signs strip uses fixed dimension labels that never rotate based on counts", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Fixed labels must be present (each represents one distinct dimension).
  assert.match(src, NEEDS_ATTENTION_LABEL_RE);
  assert.match(src, RUNNING_LABEL_RE);
  assert.match(src, STALE_LABEL_RE);
  // Dynamic-label helper functions that rotated labels based on counts must
  // not exist; they made the strip non-comparable across page refreshes.
  assert.doesNotMatch(src, NO_ACTIVE_RUNS_RETURN_RE);
  assert.doesNotMatch(src, FAILING_RETURN_RE);
  assert.doesNotMatch(src, ALL_FRESH_RETURN_RE);
  assert.doesNotMatch(src, STALE_OVER_SEVEN_DAYS_RETURN_RE);
  assert.doesNotMatch(src, NO_SCHEDULER_RUN_RETURN_RE);
  // The Idle health label must never appear in the list view.
  assert.doesNotMatch(src, IDLE_RETURN_RE);
});

test("sort key uses health projection state to surface attention-required connections", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The sort key must check health state, not just run history.
  // needs_attention and blocked are the two states that require owner action
  // and must bubble to the top of the list.
  assert.match(src, NEEDS_ATTENTION_STATE_RE);
  assert.match(src, BLOCKED_STATE_RE);
  assert.match(src, DEGRADED_STATE_RE);
  // Run-history failure is only used as a fallback when no health projection
  // is present, not as the primary sort signal.
  assert.match(src, FAILED_RUN_FALLBACK_RE);
});

test("stale count uses health projection freshness axis when available", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The stale count should check the projection's freshness axis first.
  assert.match(src, STALE_FRESHNESS_AXIS_RE);
});

test("needs-attention count uses health projection blocked and needs_attention states", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, NEEDS_ATTENTION_COUNT_RE);
});

test("running count includes health projection syncing badge", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // push-mode local collectors report progress via the syncing badge, not
  // isRunning, so the count must include both signals.
  assert.match(src, SYNCING_BADGE_RE);
});
