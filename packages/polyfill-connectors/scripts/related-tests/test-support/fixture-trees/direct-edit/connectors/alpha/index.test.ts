import assert from "node:assert/strict";
import { test } from "node:test";
import { runAlpha } from "./index.ts";

test("runAlpha returns alpha", () => {
  assert.equal(runAlpha(), "alpha");
});
