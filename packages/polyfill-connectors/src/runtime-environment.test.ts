import assert from "node:assert/strict";
import test from "node:test";
import { isRunningInContainer } from "./runtime-environment.ts";

test("isRunningInContainer returns false on a clean host", () => {
  assert.equal(
    isRunningInContainer(
      { PDPP_REFERENCE_MODE: undefined, PDPP_FORCE_CONTAINER: undefined },
      { fileExists: () => false }
    ),
    false
  );
});

test("isRunningInContainer detects PDPP_REFERENCE_MODE=composed", () => {
  assert.equal(isRunningInContainer({ PDPP_REFERENCE_MODE: "composed" }, { fileExists: () => false }), true);
});

test("isRunningInContainer detects /.dockerenv presence", () => {
  assert.equal(isRunningInContainer({}, { fileExists: (p) => p === "/.dockerenv" }), true);
});

test("isRunningInContainer honors PDPP_FORCE_CONTAINER=1", () => {
  assert.equal(isRunningInContainer({ PDPP_FORCE_CONTAINER: "1" }, { fileExists: () => false }), true);
});

test("isRunningInContainer ignores arbitrary PDPP_REFERENCE_MODE values", () => {
  assert.equal(isRunningInContainer({ PDPP_REFERENCE_MODE: "host" }, { fileExists: () => false }), false);
});

test("isRunningInContainer trims whitespace before matching", () => {
  assert.equal(isRunningInContainer({ PDPP_REFERENCE_MODE: "  composed  " }, { fileExists: () => false }), true);
});

test("isRunningInContainer treats fileExists throw as 'not detected'", () => {
  assert.equal(
    isRunningInContainer(
      {},
      {
        fileExists: () => {
          throw new Error("simulated fs failure");
        },
      }
    ),
    false
  );
});
