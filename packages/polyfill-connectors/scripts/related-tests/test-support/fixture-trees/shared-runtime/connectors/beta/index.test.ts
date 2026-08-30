import assert from "node:assert/strict";
import { test } from "node:test";
import { runBeta } from "./index.ts";

test("runBeta includes the shared helper's output", () => {
  assert.equal(runBeta(), "beta-shared");
});
