// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isRunningInContainer } from "./runtime-environment.ts";

test("isRunningInContainer returns false on a clean host", () => {
  assert.equal(isRunningInContainer({ PDPP_FORCE_CONTAINER: undefined }, { fileExists: () => false }), false);
});

test("isRunningInContainer detects /.dockerenv presence", () => {
  assert.equal(isRunningInContainer({}, { fileExists: (p) => p === "/.dockerenv" }), true);
});

test("isRunningInContainer honors PDPP_FORCE_CONTAINER=1", () => {
  assert.equal(isRunningInContainer({ PDPP_FORCE_CONTAINER: "1" }, { fileExists: () => false }), true);
});

test("isRunningInContainer ignores PDPP_REFERENCE_MODE entirely (composed is an origin-layout signal, not a container signal)", () => {
  // Regression: prior to 2026-04-27 the detector treated
  // PDPP_REFERENCE_MODE=composed as a container signal. That was a
  // category error — composed mode describes the BFF/AS/RS origin
  // layout, not container-vs-host — and false-tripped the headed-
  // browser fail-closed gate for native dev sessions.
  assert.equal(
    isRunningInContainer(
      { PDPP_REFERENCE_MODE: "composed", PDPP_FORCE_CONTAINER: undefined } as Record<string, string | undefined>,
      { fileExists: () => false }
    ),
    false
  );
});

test("isRunningInContainer trims whitespace before matching PDPP_FORCE_CONTAINER", () => {
  assert.equal(isRunningInContainer({ PDPP_FORCE_CONTAINER: "  1  " }, { fileExists: () => false }), true);
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
