import assert from "node:assert/strict";
import { test } from "node:test";
import { runBeta } from "./index.ts";

test("runBeta returns beta", () => {
  assert.equal(runBeta(), "beta");
});
