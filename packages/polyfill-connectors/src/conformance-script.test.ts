// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { checkManifest } from "../scripts/conformance.ts";

test("conformance reports the manifest's nested public-listing evidence status", () => {
  const step = checkManifest("google_maps");
  assert.equal(step.verdict, "PASS");
  assert.match(step.detail, /evidence level "needs_human_auth"/);
});
