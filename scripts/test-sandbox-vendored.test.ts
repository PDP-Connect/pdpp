// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sandboxDir = join(dirname(fileURLToPath(import.meta.url)), "test-sandbox");

test("vendored test-sandbox matches its recorded sha256 and stays executable", () => {
  const recorded = readFileSync(join(sandboxDir, "test-sandbox.sha256"), "utf8").trim();
  const actual = createHash("sha256")
    .update(readFileSync(join(sandboxDir, "test-sandbox")))
    .digest("hex");
  assert.equal(recorded, `${actual}  test-sandbox`);
  // Git records mode 100755; shared worktrees may add group write on checkout.
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a mask.
  assert.equal(statSync(join(sandboxDir, "test-sandbox")).mode & 0o111, 0o111);
});
