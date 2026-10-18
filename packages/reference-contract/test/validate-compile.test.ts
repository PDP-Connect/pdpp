// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";

import { compileAllValidators } from "../src/validate.ts";

// Request and response validators compile lazily, so the rest of this suite
// only compiles the operations it touches. This test compiles every one of
// them, so a broken schema fails here rather than on its first validation.

test("every request and response schema compiles", () => {
  compileAllValidators();
});
