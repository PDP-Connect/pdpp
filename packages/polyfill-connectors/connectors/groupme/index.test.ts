// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("GroupMe connector", () => {
  it("is properly exported", async () => {
    const mod = await import("./index.ts");
    assert.ok(mod, "module should exist");
  });
});
