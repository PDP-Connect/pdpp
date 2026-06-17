import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBrowserSessionLaunchResult } from "./[connectorId]/launch/launch-result.ts";

test("browser-session launch routes a started run to its stream page", () => {
  assert.deepEqual(classifyBrowserSessionLaunchResult({ run_id: "run_123", status: "started" }), {
    href: "/dashboard/runs/run_123/stream",
    ok: true,
    run_id: "run_123",
  });
});

test("browser-session launch does not route a surface_failed preflight run to stream", () => {
  const result = classifyBrowserSessionLaunchResult({
    browser_surface: { browser_surface_status: "surface_failed" },
    run_id: "run_surface_failed",
    status: "surface_failed",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.message, /could not get the secure browser ready/i);
  assert.doesNotMatch(result.message, /service health/i);
  assert.equal("href" in result, false);
});

test("browser-session launch keeps queued browser runs on the launch page", () => {
  const result = classifyBrowserSessionLaunchResult({
    browser_surface: {
      browser_surface_status: "waiting_for_browser_surface",
      browser_surface_wait_reason: "capacity_full",
    },
    run_id: "run_waiting",
    status: "waiting_for_browser_surface",
  });

  assert.deepEqual(result, {
    message: "The secure browser is busy (capacity_full). Try again in a moment.",
    ok: false,
    run_status: "waiting_for_browser_surface",
    status: 409,
  });
});

test("browser-session launch fails closed when the controller returns no run id", () => {
  const result = classifyBrowserSessionLaunchResult({ status: "started" });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.message, /no run id/i);
});
