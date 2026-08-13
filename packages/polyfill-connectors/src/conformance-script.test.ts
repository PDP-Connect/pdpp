// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { checkManifest } from "../scripts/conformance.ts";

test("conformance reports the manifest's lifecycle tier", () => {
  const step = checkManifest("google_maps");
  assert.equal(step.verdict, "PASS");
  assert.match(step.detail, /lifecycle tier "supported"/);
});
