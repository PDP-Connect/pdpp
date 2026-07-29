// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route/host wiring test for the run-timeline `terminal_status` field.
 *
 * Proves the window-independence guarantee end-to-end against the real
 * SQLite spine: a run whose terminal event is BEYOND the first page (more
 * events than the requested `limit`) still reports `terminal_status` on the
 * first-page response. A run with no terminal event reports `null`.
 *
 * The terminal status is resolved by `getRunTerminalStatus` (the bounded
 * `ORDER BY event_seq DESC LIMIT 1` terminal-event query) and threaded
 * through the actual `mountRefRunTimeline` handler, which is exercised here
 * with a mock Express app — same code path as production.
 *
 * Spec: openspec/changes/add-run-timeline-terminal-status/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent, getRunTerminalStatus, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { MountRefSpineTimelinesContext } from "../server/routes/ref-spine-timelines.ts";
import { mountRefRunTimeline } from "../server/routes/ref-spine-timelines.ts";

interface TimelineBody {
  readonly data: readonly Record<string, unknown>[];
  readonly event_count: number;
  readonly next_cursor?: string | null;
  readonly object: string;
  readonly run_id: string;
  readonly terminal_status: string | null;
  readonly truncated: boolean;
}

async function withSpine(fn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await fn();
  } finally {
    closeDb();
  }
}

// A minimal Express-shaped harness that captures the single GET handler
// registered by `mountRefRunTimeline`, then invokes it with a request and a
// response recorder. Mirrors the production handler chain (the owner-session
// middleware is a no-op here; auth posture is covered elsewhere).
function buildHarness(ctx: MountRefSpineTimelinesContext): {
  invoke: (runId: string, query?: Record<string, string>) => Promise<TimelineBody>;
} {
  let handler: ((req: unknown, res: unknown) => unknown) | null = null;
  const app: Parameters<typeof mountRefRunTimeline>[0] = {
    get(_path, ...handlers) {
      handler = (handlers.at(-1) as typeof handler) ?? null;
      return app;
    },
  };
  mountRefRunTimeline(app, ctx);
  return {
    async invoke(runId: string, query: Record<string, string> = {}): Promise<TimelineBody> {
      if (!handler) {
        throw new Error("timeline route handler was not registered");
      }
      const recorder: { body: unknown } = { body: undefined };
      const res = {
        json(body: unknown) {
          recorder.body = body;
          return body;
        },
      };
      await handler({ params: { runId: encodeURIComponent(runId) }, query }, res);
      if (!recorder.body || typeof recorder.body !== "object") {
        throw new Error("expected timeline response body");
      }
      return recorder.body as TimelineBody;
    },
  };
}

function makeCtx(): MountRefSpineTimelinesContext {
  return {
    getRunTerminalStatus: (runId) => getRunTerminalStatus(runId),
    handleError(_res, err) {
      throw err;
    },
    listSpineEventsPage: (kind, id, opts) => {
      const page = listSpineEventsPage(kind, id, opts);
      return { ...page, events: page.events.map((event) => ({ ...event })) };
    },
    pdppError(res, status, code, message) {
      if (res && typeof res === "object" && "json" in res && typeof res.json === "function") {
        res.json({ error: { code, message, status }, object: "error" });
      }
    },
    requireOwnerSession: (_req, _res, next) => (typeof next === "function" ? next() : undefined),
  };
}

async function seedRunWithTerminalTail(runId: string, nonTerminalCount: number, terminalType: string): Promise<void> {
  for (let i = 0; i < nonTerminalCount; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await emitSpineEvent({
      event_type: "run.detail_gap_recorded",
      object_id: runId,
      object_type: "run",
      occurred_at: `2026-04-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      run_id: runId,
      status: "unknown",
    });
  }
  const status = terminalType === "run.completed" ? "completed" : terminalType.split(".")[1];
  if (!status) {
    throw new Error(`missing terminal status for ${terminalType}`);
  }
  await emitSpineEvent({
    event_type: terminalType,
    object_id: runId,
    object_type: "run",
    occurred_at: "2026-04-01T01:00:00Z",
    run_id: runId,
    status,
  });
}

test("getRunTerminalStatus resolves the tail terminal event independent of page window", async () => {
  await withSpine(async () => {
    const runId = "run_long_cancelled";
    await seedRunWithTerminalTail(runId, 12, "run.cancelled");

    // First page with a tiny limit: the terminal event is NOT in this window.
    const firstPage = listSpineEventsPage("run", runId, { limit: 3 });
    assert.equal(firstPage.events.length, 3);
    assert.ok(
      firstPage.events.every((e) => e.event_type !== "run.cancelled"),
      "precondition: terminal event must be beyond the first page"
    );

    const status = await getRunTerminalStatus(runId);
    assert.equal(status, "cancelled", "terminal status comes from the tail, not the page window");
  });
});

test("run-timeline route reports terminal_status on the FIRST small-limit page (window-independent)", async () => {
  await withSpine(async () => {
    const runId = "run_route_long_cancelled";
    await seedRunWithTerminalTail(runId, 12, "run.cancelled");

    const harness = buildHarness(makeCtx());
    const firstPage = await harness.invoke(runId, { limit: "3" });

    assert.equal(firstPage.object, "run_timeline");
    assert.equal(firstPage.run_id, runId);
    assert.equal(firstPage.event_count, 3, "first page is the small-limit window, not the whole run");
    assert.equal(firstPage.truncated, true);
    assert.equal(firstPage.terminal_status, "cancelled");
    assert.ok(
      firstPage.data.every((e) => e.event_type !== "run.cancelled"),
      "the terminal event is genuinely off this page"
    );
  });
});

test("run-timeline route terminal_status is identical across pages of the same run", async () => {
  await withSpine(async () => {
    const runId = "run_route_paged";
    await seedRunWithTerminalTail(runId, 10, "run.completed");

    const harness = buildHarness(makeCtx());
    const page1 = await harness.invoke(runId, { limit: "4" });
    assert.equal(page1.terminal_status, "completed");
    assert.ok(page1.next_cursor, "expected a next cursor for a paged run");

    const page2 = await harness.invoke(runId, { cursor: page1.next_cursor, limit: "4" });
    assert.equal(page2.terminal_status, "completed", "same value on any page");
  });
});

test("run-timeline route reports terminal_status null for an in-progress run", async () => {
  await withSpine(async () => {
    const runId = "run_route_in_progress";
    // A run with only non-terminal events (no run.completed/failed/cancelled/
    // abandoned). We deliberately avoid run.started — its boot_epoch stamping
    // is irrelevant to this assertion and the terminal lookup is the subject.
    await emitSpineEvent({
      event_type: "run.progress_reported",
      object_id: runId,
      object_type: "run",
      occurred_at: "2026-04-01T00:00:00Z",
      run_id: runId,
      status: "unknown",
    });
    await emitSpineEvent({
      event_type: "run.progress_reported",
      object_id: runId,
      object_type: "run",
      occurred_at: "2026-04-01T00:00:01Z",
      run_id: runId,
      status: "unknown",
    });

    const harness = buildHarness(makeCtx());
    const page = await harness.invoke(runId, { limit: "10" });
    assert.equal(page.terminal_status, null);
  });
});

test("run-timeline route treats browser surface failure as a failed terminal run", async () => {
  await withSpine(async () => {
    const runId = "run_route_surface_failed";
    await emitSpineEvent({
      actor_id: "amazon",
      actor_type: "runtime",
      data: {
        browser_surface: {
          browser_surface_lease_id: "lease_surface_failed",
          browser_surface_profile_key: "amazon:cin_surface_failed",
          browser_surface_status: "surface_failed",
          browser_surface_wait_reason: "surface_start_failed",
          pending_run_id: runId,
        },
        source: { id: "amazon", kind: "connector" },
      },
      event_type: "run.browser_surface_failed",
      object_id: runId,
      object_type: "run",
      occurred_at: "2026-04-01T00:00:00Z",
      run_id: runId,
      source_id: "amazon",
      source_kind: "connector",
      status: "surface_failed",
    });

    const harness = buildHarness(makeCtx());
    const page = await harness.invoke(runId, { limit: "10" });
    assert.equal(page.terminal_status, "failed");
  });
});

test("run-timeline route maps run.abandoned to the abandoned terminal class", async () => {
  await withSpine(async () => {
    const runId = "run_route_abandoned";
    await seedRunWithTerminalTail(runId, 2, "run.abandoned");

    const harness = buildHarness(makeCtx());
    const page = await harness.invoke(runId, { limit: "50" });
    assert.equal(page.terminal_status, "abandoned");
  });
});
