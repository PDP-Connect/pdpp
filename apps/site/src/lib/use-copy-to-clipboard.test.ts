// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { copyStatusText } from "./use-copy-to-clipboard.ts";

test("idle status has no label text and no announcement", () => {
  assert.deepEqual(copyStatusText("idle"), { announcement: "", label: "Copy" });
});

test("copied status announces success", () => {
  assert.deepEqual(copyStatusText("copied"), { announcement: "Command copied to clipboard.", label: "Copied" });
});

test("failed status announces failure", () => {
  assert.deepEqual(copyStatusText("failed"), { announcement: "Copy failed.", label: "Copy failed" });
});
