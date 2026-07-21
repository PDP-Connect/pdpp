import assert from "node:assert/strict";
import test from "node:test";
import { isActiveConnectorRunSummaryStatus } from "./connector-run-summary-status.ts";

test("isActiveConnectorRunSummaryStatus accepts only the current connector-summary active states", () => {
  for (const status of ["pending", "started", "in_progress"]) {
    assert.equal(isActiveConnectorRunSummaryStatus(status), true, `${status} should be active`);
  }

  for (const status of ["succeeded", "error", "future_status"]) {
    assert.equal(isActiveConnectorRunSummaryStatus(status), false, `${status} should not be active`);
  }
});
