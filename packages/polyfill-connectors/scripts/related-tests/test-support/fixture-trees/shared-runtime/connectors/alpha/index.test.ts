import assert from "node:assert/strict";
import { test } from "node:test";
import { runAlpha } from "./index.ts";

test("runAlpha includes the shared helper's output", () => {
  assert.equal(runAlpha(), "alpha-shared");
});
