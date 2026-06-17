/**
 * Coverage for the whole-handle terminal/active decision on the run detail
 * page. Runtime terminal events still flow through the timeline envelope, but
 * browser-surface setup handles can fail before `run.started`; those use the
 * run-status handle.
 *
 * Root cause being fixed: the page used to derive `active` by scanning a single
 * page of timeline events (`getTerminalRunStatus(events) == null`). The terminal
 * event is emitted LAST, so for a run longer than the page the first page is all
 * non-terminal events and the page wrongly concluded the run was active forever
 * (wrong badge, never-disabled poller, wrongly-rendered Cancel control).
 *
 * The decision logic is extracted into `run-terminal-status.ts` so it can be
 * exercised behaviourally here (no JSX render harness in this app). The page's
 * gates are also pinned via source regex against `page.tsx`, and the wire
 * round-trip of `terminal_status` through `ref-client.ts` is checked.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type EnvelopeTerminalStatus,
  isRunHandleActive,
  isRunActive,
  mapEnvelopeTerminalToDisplay,
  mapRunHandleStatusToDisplay,
  resolveDisplayTerminalStatus,
  type TerminalRunStatus,
} from "./run-terminal-status.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const REF_CLIENT_FILE = `${HERE}../../lib/ref-client.ts`;

// ── Behavioural: the envelope is the source of truth for liveness ─────────────

test("isRunActive treats a null terminal_status as active and any class as terminal", () => {
  assert.equal(isRunActive(null), true);
  assert.equal(isRunActive("completed"), false);
  assert.equal(isRunActive("failed"), false);
  assert.equal(isRunActive("cancelled"), false);
  assert.equal(isRunActive("abandoned"), false);
});

test("run-status handle treats browser-surface failed setup as terminal, not cancellable active work", () => {
  assert.equal(isRunHandleActive("surface_failed"), false);
  assert.equal(mapRunHandleStatusToDisplay("surface_failed"), "failed");
  assert.equal(isRunHandleActive("waiting_for_browser_surface"), true);
  assert.equal(isRunHandleActive("starting_surface"), true);
  assert.equal(isRunHandleActive("leased"), true);
});

test("terminal_status drives a terminal decision even when the events page has NO terminal event", () => {
  // The defining scenario: the run is terminal per the envelope, but the
  // fetched page window contains no terminal event (in-page scan returns null).
  // The display must still show the terminal class — not active.
  const envelopeTerminal: EnvelopeTerminalStatus = "cancelled"; // resolved server-side from the tail
  const inPageTerminalStatus: TerminalRunStatus = null; // the page window never saw the terminal event

  assert.equal(isRunActive(envelopeTerminal), false, "run must NOT be active");
  assert.equal(
    resolveDisplayTerminalStatus({ coverageGapCount: 0, envelopeTerminal, inPageTerminalStatus }),
    "cancelled",
    "off-page terminal still renders the terminal class"
  );
});

test("mapEnvelopeTerminalToDisplay mirrors the page mapping (completed→succeeded, abandoned→failed)", () => {
  assert.equal(mapEnvelopeTerminalToDisplay("completed"), "succeeded");
  assert.equal(mapEnvelopeTerminalToDisplay("failed"), "failed");
  assert.equal(mapEnvelopeTerminalToDisplay("cancelled"), "cancelled");
  assert.equal(mapEnvelopeTerminalToDisplay("abandoned"), "failed");
});

test("resolveDisplayTerminalStatus prefers in-page detail when the terminal event IS on the page", () => {
  // Envelope says failed (raw class); the in-page scan distinguishes an
  // owner-cancelled crash. The finer in-page reading wins when present.
  assert.equal(
    resolveDisplayTerminalStatus({
      coverageGapCount: 0,
      envelopeTerminal: "failed",
      inPageTerminalStatus: "cancelled",
    }),
    "cancelled"
  );
});

test("resolveDisplayTerminalStatus promotes succeeded→succeeded_with_gaps when coverage gaps exist", () => {
  assert.equal(
    resolveDisplayTerminalStatus({
      coverageGapCount: 2,
      envelopeTerminal: "completed",
      inPageTerminalStatus: "succeeded",
    }),
    "succeeded_with_gaps"
  );
  // …including when the terminal event is off-page (falls back to the mapped
  // envelope class, then promotes).
  assert.equal(
    resolveDisplayTerminalStatus({
      coverageGapCount: 1,
      envelopeTerminal: "completed",
      inPageTerminalStatus: null,
    }),
    "succeeded_with_gaps"
  );
});

test("resolveDisplayTerminalStatus reports no terminal class for an active run", () => {
  assert.equal(
    resolveDisplayTerminalStatus({
      coverageGapCount: 0,
      envelopeTerminal: null,
      inPageTerminalStatus: null,
    }),
    null
  );
});

// ── Page wiring: active is handle-driven; gates follow it ─────────────────────

const PAGE_ACTIVE_FROM_RUN_STATUS_RE =
  /const active = runStatus \? isRunHandleActive\(runStatus\.status\) : isRunActive\(envelopeTerminal\);/;
// The old, buggy derivation (active straight off a single-page event scan) must
// be gone.
const PAGE_OLD_ACTIVE_RE = /const active = (getTerminalRunStatus\(events\)|terminalStatus) == null;/;
const PAGE_POLLER_GATE_RE = /<RunDetailPoller enabled=\{active\} \/>/;
const PAGE_CANCEL_GATE_RE = /\{active \? <CancelRunControl runId=\{runId\} \/> : null\}/;
const PAGE_DISPLAY_FROM_ENVELOPE_RE = /resolveDisplayTerminalStatus\(\{/;
const PAGE_DISPLAY_FROM_RUN_STATUS_RE = /mapRunHandleStatusToDisplay\(runStatus\?\.status \?\? null\)/;

test("run detail page derives `active` from run-status handle, falling back to envelope terminal_status", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_ACTIVE_FROM_RUN_STATUS_RE);
  assert.doesNotMatch(src, PAGE_OLD_ACTIVE_RE, "active must not be derived from scanning a single event page");
});

test("the poller and cancel control both gate on the handle-based `active`", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_POLLER_GATE_RE);
  assert.match(src, PAGE_CANCEL_GATE_RE);
});

test("the displayed terminal class is resolved via the envelope-anchored helper", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_DISPLAY_FROM_ENVELOPE_RE);
  assert.match(src, PAGE_DISPLAY_FROM_RUN_STATUS_RE);
});

// ── ref-client: TimelineEnvelope carries terminal_status through normalize ────

const REF_TYPE_HAS_TERMINAL_STATUS_RE =
  /terminal_status\?: "completed" \| "failed" \| "cancelled" \| "abandoned" \| null;/;
const REF_NORMALIZE_CARRIES_TERMINAL_RE = /terminal_status: terminalStatus,/;

test("TimelineEnvelope type and normalizeTimeline carry terminal_status", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  assert.match(src, REF_TYPE_HAS_TERMINAL_STATUS_RE);
  assert.match(src, REF_NORMALIZE_CARRIES_TERMINAL_RE);
});
