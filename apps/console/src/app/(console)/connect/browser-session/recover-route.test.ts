import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecoverableBrowserSessionRun } from "./[connectorId]/launch/recovery-classification.ts";

test("browser-session launch recovery only reuses active browser runs", () => {
  for (const status of ["started", "in_progress", "starting_surface", "waiting_for_browser_surface"]) {
    assert.equal(isRecoverableBrowserSessionRun({ status } as never), true, `${status} is recoverable`);
  }
});

test("browser-session launch recovery ignores terminal and failed browser-surface runs", () => {
  for (const status of ["cancelled", "failed", "rejected", "succeeded", "surface_failed", "released", "expired"]) {
    assert.equal(isRecoverableBrowserSessionRun({ status } as never), false, `${status} is not recoverable`);
  }
});
