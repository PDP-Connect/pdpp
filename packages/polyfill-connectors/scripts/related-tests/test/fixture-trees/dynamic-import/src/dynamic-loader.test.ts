import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./dynamic-loader.ts";

test("loadModule is a function", () => {
  assert.equal(typeof loadModule, "function");
});
